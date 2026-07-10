import { deflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  BinaryReader,
  BinaryWriter,
  codeWidth,
  ConnectionType,
  decodeFrame,
  DistributedCode,
  encodeFrame,
  FrameDecoder,
  PeerCode,
  PeerInitCode,
  peer,
  peerInit,
  ProtocolError,
  server,
  ServerCode,
  UserStatus,
  type Frame,
  type SharedFile,
} from '../src/protocol/index.js'

const frame = (code: number, writer = new BinaryWriter()): Frame => ({ code, payload: writer.build() })
const serverData = (code: number, writer = new BinaryWriter()) => decodeFrame('server', frame(code, writer)).data
const peerData = (value: Frame, maxInflatedSize?: number) =>
  decodeFrame('peer', value, maxInflatedSize === undefined ? {} : { maxInflatedSize }).data

function writeStrings(writer: BinaryWriter, values: readonly string[]): BinaryWriter {
  writer.uint32(values.length)
  for (const value of values) writer.string(value)
  return writer
}

function writeRoomUsers(writer: BinaryWriter): BinaryWriter {
  writeStrings(writer, ['alice'])
  writer.uint32(1).uint32(UserStatus.Online)
  writer.uint32(1).uint32(100).uint32(2).uint32(3).uint32(4).uint32(5)
  writer.uint32(1).uint32(0)
  writer.uint32(1).string('US')
  return writer
}

const fullFile: SharedFile = {
  code: 1,
  filename: 'Music\\track.flac',
  size: 123n,
  extension: 'flac',
  attributes: {
    bitrate: 1000,
    length: 10,
    variableBitrate: true,
    encoder: 2,
    sampleRate: 48_000,
    bitDepth: 24,
    unknown: new Map([[99, 7]]),
  },
}

describe('binary primitives', () => {
  it('round-trips every primitive, grows, and exposes reader state', () => {
    const writer = new BinaryWriter(1)
      .uint8(7)
      .bool(true)
      .bool(false)
      .int32(-7)
      .uint32(0xffff_ffff)
      .uint64(9n)
      .uint64(10)
      .bytes(Buffer.from([1, 2]))
      .string('héllo')
      .ipv4('1.2.3.4')
      .raw(Buffer.from([8, 9]))
    expect(writer.length).toBeGreaterThan(1)
    const reader = new BinaryReader(writer.build())
    expect(reader.offset).toBe(0)
    expect(reader.uint8()).toBe(7)
    expect(reader.bool()).toBe(true)
    expect(reader.bool()).toBe(false)
    expect(reader.int32()).toBe(-7)
    expect(reader.uint32()).toBe(0xffff_ffff)
    expect(reader.uint64()).toBe(9n)
    expect(reader.uint64()).toBe(10n)
    expect(reader.bytes()).toEqual(Buffer.from([1, 2]))
    expect(reader.string()).toBe('héllo')
    expect(reader.ipv4()).toBe('1.2.3.4')
    expect(reader.skip(1).rest()).toEqual(Buffer.from([9]))
    expect(reader.done).toBe(true)
    expect(reader.remaining).toBe(0)
  })

  it('decodes legacy latin-1 strings', () => {
    const writer = new BinaryWriter().uint32(1).uint8(0xff)
    expect(new BinaryReader(writer.build()).string()).toBe('ÿ')
  })

  it('rejects invalid writes, addresses, capacities, and reads', () => {
    for (const capacity of [0, 1.5]) expect(() => new BinaryWriter(capacity)).toThrow(RangeError)
    const invalid: Array<() => unknown> = [
      () => new BinaryWriter().uint8(-1),
      () => new BinaryWriter().uint8(256),
      () => new BinaryWriter().int32(0x8000_0000),
      () => new BinaryWriter().uint32(-1),
      () => new BinaryWriter().uint64(-1n),
      () => new BinaryWriter().uint64(0x1_0000_0000_0000_0000n),
      () => new BinaryWriter().ipv4('not-an-ip'),
      () =>
        new BinaryWriter().raw({
          byteLength: 0x1_0000_0000,
          byteOffset: 0,
          buffer: new ArrayBuffer(0),
        } as Uint8Array<ArrayBuffer>),
    ]
    for (const operation of invalid) expect(operation).toThrow()
    const reader = new BinaryReader(Buffer.alloc(0))
    expect(() => reader.uint8()).toThrow(ProtocolError)
    expect(() => reader.raw(-1)).toThrow(RangeError)
    expect(() => reader.raw(1)).toThrow(ProtocolError)
  })
})

describe('frames', () => {
  it('encodes both code widths and incrementally decodes multiple frames', () => {
    expect(codeWidth('server')).toBe(4)
    expect(codeWidth('peer')).toBe(4)
    expect(codeWidth('peer-init')).toBe(1)
    expect(codeWidth('distributed')).toBe(1)
    const first = encodeFrame('server', 42, Buffer.from('one'))
    const second = encodeFrame('server', 43, Buffer.from('two'))
    const decoder = new FrameDecoder('server')
    expect(decoder.push(Buffer.alloc(0))).toEqual([])
    expect(decoder.push(first.subarray(0, 2))).toEqual([])
    expect(decoder.bufferedBytes).toBe(2)
    const decoded = decoder.push(Buffer.concat([first.subarray(2), second]))
    expect(decoded.map(({ code, payload }) => [code, payload.toString()])).toEqual([
      [42, 'one'],
      [43, 'two'],
    ])
    expect(decoder.bufferedBytes).toBe(0)
    expect(new FrameDecoder('peer-init').push(encodeFrame('peer-init', 1))[0]?.code).toBe(1)
    const trailing = new FrameDecoder('server')
    expect(trailing.push(Buffer.concat([first, Buffer.from([1, 2])]))).toHaveLength(1)
    expect(trailing.bufferedBytes).toBe(2)
    expect(new FrameDecoder('server').push(Buffer.from([8, 0, 0, 0, 1, 0]))).toEqual([])
  })

  it('bounds frame sizes and validates framing options', () => {
    expect(() => new FrameDecoder('server', { maxFrameSize: 3 })).toThrow(RangeError)
    expect(() => new FrameDecoder('server', { maxFrameSize: 1.5 })).toThrow(RangeError)
    expect(() => new FrameDecoder('server').push(Buffer.from([3, 0, 0, 0, 0, 0, 0]))).toThrow(
      ProtocolError,
    )
    expect(() =>
      new FrameDecoder('peer-init', { maxFrameSize: 2 }).push(Buffer.from([3, 0, 0, 0])),
    ).toThrow(ProtocolError)
  })
})

describe('outgoing encoders', () => {
  it('covers every server encoder and preserves message codes', () => {
    const calls: Frame[] = [
      server.raw(999),
      server.raw(998, new BinaryWriter().uint8(1)),
      server.login('user', 'pass'),
      server.login('user', 'pass', 160, 17),
      server.setListenPort(1234),
      server.getPeerAddress('a'),
      server.watchUser('a'),
      server.unwatchUser('a'),
      server.getUserStatus('a'),
      server.ignoreUser('a'),
      server.unignoreUser('a'),
      server.sayChatroom('r', 'm'),
      server.joinRoom('r'),
      server.joinRoom('r', true),
      server.leaveRoom('r'),
      server.connectToPeer(1, 'a', ConnectionType.Peer),
      server.messageUser('a', 'm'),
      server.acknowledgeMessage(1),
      server.search(1, 'q'),
      server.setStatus(UserStatus.Away),
      server.ping(),
      server.sharedCounts(1, 2),
      server.getUserStats('a'),
      server.userSearch('a', 1, 'q'),
      server.addLike('x'),
      server.removeLike('x'),
      server.recommendations(),
      server.globalRecommendations(),
      server.userInterests('a'),
      server.roomList(),
      server.haveNoParent(true),
      server.checkPrivileges(),
      server.acceptChildren(false),
      server.wishlistSearch(1, 'q'),
      server.similarUsers(),
      server.itemRecommendations('x'),
      server.itemSimilarUsers('x'),
      server.setRoomTicker('r', 'x'),
      server.addHate('x'),
      server.removeHate('x'),
      server.roomSearch('r', 1, 'q'),
      server.sendUploadSpeed(1),
      server.givePrivileges('a', 1),
      server.branchLevel(1),
      server.branchRoot('a'),
      server.addRoomMember('r', 'a'),
      server.removeRoomMember('r', 'a'),
      server.cancelRoomMembership('r'),
      server.cancelRoomOwnership('r'),
      server.enableRoomInvitations(true),
      server.changePassword('p'),
      server.addRoomOperator('r', 'a'),
      server.removeRoomOperator('r', 'a'),
      server.messageUsers(['a', 'b'], 'm'),
      server.messageUsers([], 'm'),
      server.joinGlobalRoom(),
      server.leaveGlobalRoom(),
      server.relatedSearch('q'),
      server.cannotConnectToPeer(1, 'a'),
    ]
    expect(calls).toHaveLength(59)
    expect(calls.every(({ code, payload }) => Number.isInteger(code) && Buffer.isBuffer(payload))).toBe(true)
    const login = new BinaryReader(calls[2]!.payload)
    expect([login.string(), login.string(), login.uint32(), login.string(), login.uint32()]).toEqual([
      'user',
      'pass',
      177,
      '63e780c3f321d13109c71bf81805476e',
      1,
    ])
  })

  it('covers peer and initialization encoders, compression, and optional fields', () => {
    expect(peerInit.pierceFirewall(7).code).toBe(PeerInitCode.PierceFirewall)
    expect(peerInit.initialize('me', ConnectionType.Peer).code).toBe(PeerInitCode.PeerInit)
    const calls = [
      peer.raw(999),
      peer.browseRequest(),
      peer.browseResponse([{ directory: 'Music', files: [fullFile] }]),
      peer.browseResponse([], [{ directory: 'Private', files: [] }]),
      peer.searchRequest(1, 'q'),
      peer.searchResponse({
        username: 'me',
        token: 1,
        files: [fullFile],
        privateFiles: [fullFile],
        freeUploadSlots: true,
        uploadSpeed: 2,
        queueLength: 3,
      }),
      peer.searchResponse({
        username: 'me',
        token: 3,
        files: [{ code: 1, filename: 'plain', size: 1n, attributes: { variableBitrate: false } }],
        freeUploadSlots: false,
        uploadSpeed: 0,
        queueLength: 0,
      }),
      peer.searchResponse({
        username: 'me',
        token: 2,
        files: [],
        freeUploadSlots: false,
        uploadSpeed: 0,
        queueLength: 0,
      }),
      peer.infoRequest(),
      peer.infoResponse({
        description: 'd',
        picture: Buffer.from('p'),
        totalUploads: 1,
        queueSize: 2,
        slotsAvailable: true,
        uploadPermission: 3,
      }),
      peer.infoResponse({
        description: 'd',
        totalUploads: 1,
        queueSize: 2,
        slotsAvailable: false,
        uploadPermission: 3,
      }),
      peer.folderContentsRequest(1, 'Music'),
      peer.folderContentsResponse(1, 'Music', [{ directory: 'Music', files: [fullFile] }]),
      peer.transferRequest(0, 1, 'f'),
      peer.transferRequest(1, 1, 'f', 3n),
      peer.transferResponse(1, true),
      peer.transferResponse(1, true, 3n),
      peer.transferResponse(1, false, 'no'),
      peer.queueUpload('f'),
      peer.placeInQueueResponse('f', 2),
      peer.uploadFailed('f'),
      peer.uploadDenied('f', 'no'),
      peer.placeInQueueRequest('f'),
    ]
    expect(calls).toHaveLength(23)
  })
})

describe('server decoders', () => {
  it('decodes login variants', () => {
    expect(serverData(ServerCode.Login, new BinaryWriter().bool(false).string('bad'))).toEqual({
      success: false,
      rejectionReason: 'bad',
    })
    expect(serverData(ServerCode.Login, new BinaryWriter().bool(false).string('bad').string('detail'))).toEqual({
      success: false,
      rejectionReason: 'bad',
      detail: 'detail',
    })
    expect(
      serverData(
        ServerCode.Login,
        new BinaryWriter().bool(true).string('banner').ipv4('1.2.3.4').string('hash').bool(true),
      ),
    ).toEqual({ success: true, banner: 'banner', ip: '1.2.3.4', checksum: 'hash', supporter: true })
  })

  it('decodes addresses and user presence variants', () => {
    expect(
      serverData(
        ServerCode.GetPeerAddress,
        new BinaryWriter().string('u').ipv4('1.2.3.4').uint32(1),
      ),
    ).toMatchObject({ username: 'u', port: 1 })
    expect(
      serverData(
        ServerCode.GetPeerAddress,
        new BinaryWriter().string('u').ipv4('1.2.3.4').uint32(1).uint32(2).uint32(3),
      ),
    ).toMatchObject({ obfuscationType: 2, obfuscatedPort: 3 })
    expect(
      serverData(
        ServerCode.GetPeerAddress,
        new BinaryWriter().string('u').ipv4('1.2.3.4').uint32(1).uint32(2).uint8(3),
      ),
    ).toMatchObject({ obfuscatedPort: 3 })
    expect(serverData(ServerCode.WatchUser, new BinaryWriter().string('u').bool(false))).toEqual({
      username: 'u',
      exists: false,
    })
    const watch = () =>
      new BinaryWriter()
        .string('u')
        .bool(true)
        .uint32(2)
        .uint32(3)
        .uint32(4)
        .uint32(5)
        .uint32(6)
        .uint32(7)
    expect(serverData(ServerCode.WatchUser, watch())).not.toHaveProperty('country')
    expect(serverData(ServerCode.WatchUser, watch().string('US'))).toHaveProperty('country', 'US')
    expect(serverData(ServerCode.GetUserStatus, new BinaryWriter().string('u').uint32(2).bool(true))).toEqual({
      username: 'u',
      status: 2,
      privileged: true,
    })
  })

  it('decodes string, chat, room, peer, message, search, and stat messages', () => {
    const stringCodes = [
      ServerCode.IgnoreUser,
      ServerCode.UnignoreUser,
      ServerCode.LeaveRoom,
      ServerCode.RoomAdded,
      ServerCode.RoomRemoved,
      ServerCode.AddToPrivileged,
      ServerCode.RoomSomething,
      ServerCode.RoomMembershipGranted,
      ServerCode.RoomMembershipRevoked,
      ServerCode.RoomOperatorshipGranted,
      ServerCode.RoomOperatorshipRevoked,
      ServerCode.ChangePassword,
      ServerCode.CannotCreateRoom,
    ]
    for (const code of stringCodes) expect(serverData(code, new BinaryWriter().string('x'))).toEqual({ value: 'x' })
    for (const code of [ServerCode.SayChatroom, ServerCode.GlobalRoomMessage]) {
      expect(serverData(code, new BinaryWriter().string('r').string('u').string('m'))).toEqual({
        room: 'r',
        username: 'u',
        message: 'm',
      })
    }
    expect(serverData(ServerCode.JoinRoom, writeRoomUsers(new BinaryWriter().string('r')))).toMatchObject({
      room: 'r',
      private: false,
      users: [{ username: 'alice', status: 2 }],
    })
    expect(
      serverData(
        ServerCode.JoinRoom,
        writeStrings(writeRoomUsers(new BinaryWriter().string('r')).string('owner'), ['op']),
      ),
    ).toMatchObject({ private: true, owner: 'owner', operators: ['op'] })
    expect(
      serverData(
        ServerCode.UserJoinedRoom,
        new BinaryWriter()
          .string('r')
          .string('u')
          .uint32(2)
          .uint32(3)
          .uint32(4)
          .uint32(5)
          .uint32(6)
          .uint32(7)
          .uint32(8)
          .string('US'),
      ),
    ).toMatchObject({ room: 'r', user: { username: 'u', country: 'US' } })
    expect(serverData(ServerCode.UserLeftRoom, new BinaryWriter().string('r').string('u'))).toEqual({
      room: 'r',
      username: 'u',
    })
    const connect = () =>
      new BinaryWriter().string('u').string('P').ipv4('1.2.3.4').uint32(1).uint32(2).bool(true)
    expect(serverData(ServerCode.ConnectToPeer, connect())).not.toHaveProperty('obfuscationType')
    expect(serverData(ServerCode.ConnectToPeer, connect().uint32(3).uint32(4))).toHaveProperty('obfuscatedPort', 4)
    expect(
      serverData(
        ServerCode.MessageUser,
        new BinaryWriter().uint32(1).uint32(2).string('u').string('m').bool(true),
      ),
    ).toMatchObject({ id: 1, username: 'u', message: 'm' })
    expect(serverData(ServerCode.FileSearch, new BinaryWriter().string('u').uint32(1).string('q'))).toEqual({
      username: 'u',
      token: 1,
      query: 'q',
    })
    expect(
      serverData(
        ServerCode.GetUserStats,
        new BinaryWriter().string('u').uint32(1).uint32(2).uint32(3).uint32(4).uint32(5),
      ),
    ).toMatchObject({ username: 'u', directories: 5 })
    expect(serverData(ServerCode.UploadSlotsFull, new BinaryWriter().string('u').uint32(1))).toEqual({
      username: 'u',
      slotsFull: 1,
    })
  })

  it('decodes recommendation, room-list, distributed metadata, and private-room messages', () => {
    for (const code of [ServerCode.Relogged, ServerCode.Ping, ServerCode.ResetDistributed]) {
      expect(serverData(code)).toEqual({})
    }
    expect(
      serverData(ServerCode.SimilarRecommendations, writeStrings(new BinaryWriter().string('x'), ['y'])),
    ).toEqual({ item: 'x', similar: ['y'] })
    const ratings = () => new BinaryWriter().uint32(2).string('good').int32(1).string('bad').int32(-1)
    for (const code of [ServerCode.Recommendations, ServerCode.GlobalRecommendations]) {
      expect(serverData(code, ratings())).toMatchObject({
        recommendations: [{ item: 'good', score: 1 }],
        unrecommendations: [{ item: 'bad', score: -1 }],
      })
    }
    expect(serverData(ServerCode.MyRecommendations, writeStrings(new BinaryWriter(), ['x']))).toEqual({ items: ['x'] })
    expect(
      serverData(
        ServerCode.UserInterests,
        writeStrings(writeStrings(new BinaryWriter().string('u'), ['like']), ['hate']),
      ),
    ).toEqual({ username: 'u', likes: ['like'], hates: ['hate'] })
    expect(serverData(ServerCode.PlaceInLineRequest, new BinaryWriter().string('u').uint32(1))).toEqual({
      username: 'u',
      token: 1,
    })
    expect(serverData(ServerCode.PlaceInLineResponse, new BinaryWriter().string('u').uint32(1).uint32(2))).toEqual({
      username: 'u',
      token: 1,
      place: 2,
    })
    const roomList = new BinaryWriter()
    for (const withCount of [true, true, true, false]) {
      writeStrings(roomList, ['r'])
      if (withCount) roomList.uint32(1).uint32(2)
    }
    expect(serverData(ServerCode.RoomList, roomList)).toMatchObject({
      rooms: [{ name: 'r', users: 2 }],
      operated: ['r'],
    })
    const missingCount = new BinaryWriter().uint32(1).string('uncounted').uint32(0)
    for (let index = 0; index < 2; index++) missingCount.uint32(0).uint32(0)
    missingCount.uint32(0)
    expect(serverData(ServerCode.RoomList, missingCount)).toMatchObject({ rooms: [{ name: 'uncounted', users: 0 }] })
    expect(serverData(ServerCode.AdminMessage, new BinaryWriter().string('m'))).toEqual({ message: 'm' })
    expect(serverData(ServerCode.GlobalUserList, writeRoomUsers(new BinaryWriter()))).toMatchObject({
      users: [{ username: 'alice' }],
    })
    expect(serverData(ServerCode.PrivilegedUsers, writeStrings(new BinaryWriter(), ['u']))).toEqual({ users: ['u'] })
    const integerCodes = [
      ServerCode.ParentMinSpeed,
      ServerCode.ParentSpeedRatio,
      ServerCode.ParentInactivityTimeout,
      ServerCode.SearchInactivityTimeout,
      ServerCode.MinParentsInCache,
      ServerCode.DistributedPingInterval,
      ServerCode.CheckPrivileges,
      ServerCode.WishlistInterval,
    ]
    for (const code of integerCodes) expect(serverData(code, new BinaryWriter().uint32(7))).toEqual({ value: 7 })
    expect(serverData(ServerCode.EmbeddedMessage, new BinaryWriter().uint8(3).raw(Buffer.from('x')))).toMatchObject({
      code: 3,
      payload: Buffer.from('x'),
    })
    expect(
      serverData(
        ServerCode.PossibleParents,
        new BinaryWriter().uint32(1).string('u').ipv4('1.2.3.4').uint32(5),
      ),
    ).toMatchObject({ parents: [{ username: 'u', port: 5 }] })
    expect(serverData(ServerCode.SimilarUsers, new BinaryWriter().uint32(1).string('u').uint32(5))).toEqual({
      users: [{ username: 'u', rating: 5 }],
    })
    expect(serverData(ServerCode.ItemRecommendations, new BinaryWriter().string('x').raw(ratings().build()))).toMatchObject({
      item: 'x',
    })
    expect(serverData(ServerCode.ItemSimilarUsers, writeStrings(new BinaryWriter().string('x'), ['u']))).toEqual({
      item: 'x',
      users: ['u'],
    })
    expect(
      serverData(
        ServerCode.RoomTickers,
        new BinaryWriter().string('r').uint32(1).string('u').string('m'),
      ),
    ).toEqual({ room: 'r', tickers: [{ username: 'u', message: 'm' }] })
    expect(serverData(ServerCode.RoomTickerAdded, new BinaryWriter().string('r').string('u').string('m'))).toEqual({
      room: 'r',
      username: 'u',
      message: 'm',
    })
    expect(serverData(ServerCode.RoomTickerRemoved, new BinaryWriter().string('r').string('u'))).toEqual({
      room: 'r',
      username: 'u',
    })
    expect(serverData(ServerCode.UserPrivileged, new BinaryWriter().string('u').bool(true))).toEqual({
      username: 'u',
      privileged: true,
    })
    expect(serverData(ServerCode.NotifyPrivileges, new BinaryWriter().uint32(1).string('u'))).toEqual({
      token: 1,
      username: 'u',
    })
    expect(serverData(ServerCode.AcknowledgeNotifyPrivileges, new BinaryWriter().uint32(1))).toEqual({ token: 1 })
    expect(serverData(ServerCode.RoomMembers, writeStrings(new BinaryWriter().string('r'), ['u']))).toEqual({
      room: 'r',
      users: ['u'],
    })
    for (const code of [
      ServerCode.AddRoomMember,
      ServerCode.RemoveRoomMember,
      ServerCode.AddRoomOperator,
      ServerCode.RemoveRoomOperator,
    ]) {
      expect(serverData(code, new BinaryWriter().string('r').string('u'))).toEqual({ room: 'r', username: 'u' })
    }
    expect(serverData(ServerCode.EnableRoomInvitations, new BinaryWriter().bool(true))).toEqual({ enabled: true })
    expect(serverData(ServerCode.RoomOperators, writeStrings(new BinaryWriter().string('r'), ['u']))).toEqual({
      room: 'r',
      users: ['u'],
    })
    expect(serverData(ServerCode.RelatedSearch, new BinaryWriter().string('q').uint32(1).string('x').uint32(2))).toEqual({
      query: 'q',
      terms: [{ term: 'x', score: 2 }],
    })
    expect(serverData(ServerCode.ExcludedSearchPhrases, writeStrings(new BinaryWriter(), ['x']))).toEqual({ phrases: ['x'] })
    expect(serverData(ServerCode.CannotConnectToPeer, new BinaryWriter().uint32(1))).toEqual({ token: 1 })
    expect(serverData(ServerCode.CannotConnectToPeer, new BinaryWriter().uint32(1).string('u'))).toEqual({
      token: 1,
      username: 'u',
    })
    expect(serverData(999, new BinaryWriter().raw(Buffer.from('raw')))).toEqual(Buffer.from('raw'))
  })
})

describe('peer, init, and distributed decoders', () => {
  it('round-trips compressed browse, search, profile, and folder messages', () => {
    expect(peerData(peer.browseRequest())).toEqual({})
    expect(peerData(peer.browseResponse([{ directory: 'Music', files: [fullFile] }]))).toMatchObject({
      publicFolders: [{ directory: 'Music', files: [{ filename: 'Music\\track.flac' }] }],
      privateFolders: [],
      unknown: 0,
    })
    expect(peerData(peer.browseResponse([], [{ directory: 'Private', files: [] }]))).toMatchObject({
      privateFolders: [{ directory: 'Private' }],
    })
    expect(
      peerData(
        frame(
          PeerCode.BrowseResponse,
          new BinaryWriter().raw(deflateSync(new BinaryWriter().uint32(0).build())),
        ),
      ),
    ).toEqual({ publicFolders: [], privateFolders: [], unknown: 0 })
    expect(
      peerData(
        frame(
          PeerCode.BrowseResponse,
          new BinaryWriter().raw(deflateSync(new BinaryWriter().uint32(0).uint32(7).build())),
        ),
      ),
    ).toEqual({ publicFolders: [], privateFolders: [], unknown: 7 })
    expect(peerData(peer.searchRequest(1, 'q'))).toEqual({ token: 1, query: 'q' })
    const search = peer.searchResponse({
      username: 'u',
      token: 1,
      files: [fullFile],
      privateFiles: [fullFile],
      freeUploadSlots: true,
      uploadSpeed: 2,
      queueLength: 3,
    })
    expect(peerData(search)).toMatchObject({
      username: 'u',
      publicFiles: [{ attributes: { bitrate: 1000, variableBitrate: true, unknown: new Map([[99, 7]]) } }],
      privateFiles: [{ filename: 'Music\\track.flac' }],
      unknown: 0,
    })
    expect(peerData(peer.infoRequest())).toEqual({})
    expect(
      peerData(
        peer.infoResponse({
          description: 'd',
          picture: Buffer.from('p'),
          totalUploads: 1,
          queueSize: 2,
          slotsAvailable: true,
          uploadPermission: 3,
        }),
      ),
    ).toMatchObject({ hasPicture: true, picture: Buffer.from('p'), uploadPermission: 3 })
    expect(
      peerData(
        frame(PeerCode.InfoResponse, new BinaryWriter().string('d').bool(false).uint32(1).uint32(2).bool(false)),
      ),
    ).not.toHaveProperty('uploadPermission')
    expect(peerData(peer.folderContentsRequest(1, 'Music'))).toEqual({ token: 1, directory: 'Music' })
    expect(
      peerData(peer.folderContentsResponse(1, 'Music', [{ directory: 'Music', files: [fullFile] }])),
    ).toMatchObject({ token: 1, folders: [{ directory: 'Music' }] })
  })

  it('decodes transfer and queue variants and unknown messages', () => {
    expect(peerData(peer.transferRequest(0, 1, 'f'))).toEqual({ direction: 0, token: 1, filename: 'f' })
    expect(peerData(peer.transferRequest(1, 1, 'f', 3n))).toEqual({ direction: 1, token: 1, filename: 'f', size: 3n })
    expect(peerData(peer.transferResponse(1, true))).toEqual({ token: 1, allowed: true })
    expect(peerData(peer.transferResponse(1, true, 3n))).toEqual({ token: 1, allowed: true, size: 3n })
    expect(peerData(peer.transferResponse(1, false, 'no'))).toEqual({ token: 1, allowed: false, reason: 'no' })
    for (const code of [
      PeerCode.UploadPlaceholder,
      PeerCode.QueueUpload,
      PeerCode.UploadFailed,
      PeerCode.PlaceInQueueRequest,
    ]) {
      expect(peerData(frame(code, new BinaryWriter().string('f')))).toEqual({ filename: 'f' })
    }
    expect(peerData(peer.placeInQueueResponse('f', 2))).toEqual({ filename: 'f', place: 2 })
    expect(peerData(peer.uploadDenied('f', 'no'))).toEqual({ filename: 'f', reason: 'no' })
    expect(peerData(frame(PeerCode.UploadQueueNotification))).toEqual({})
    expect(peerData(frame(999, new BinaryWriter().raw(Buffer.from('x'))))).toEqual(Buffer.from('x'))
  })

  it('handles legacy sizes and rejects compressed bombs or invalid limits', () => {
    const legacy = new BinaryWriter()
      .string('u')
      .uint32(1)
      .uint32(1)
      .uint8(1)
      .string('f')
      .uint32(7)
      .uint32(0xffff_ffff)
      .uint32(0)
      .uint32(0)
      .bool(false)
      .uint32(0)
      .uint32(0)
    expect(
      peerData(frame(PeerCode.SearchResponse, new BinaryWriter().raw(deflateSync(legacy.build())))),
    ).toMatchObject({ publicFiles: [{ size: 7n }] })
    expect(() => peerData(frame(PeerCode.SearchResponse, new BinaryWriter().raw(Buffer.from('bad'))))).toThrow(
      ProtocolError,
    )
    expect(() => peerData(peer.searchResponse({ username: 'u', token: 1, files: [], freeUploadSlots: false, uploadSpeed: 0, queueLength: 0 }), 1)).toThrow(ProtocolError)
    expect(() => decodeFrame('peer', frame(PeerCode.BrowseRequest), { maxInflatedSize: 0 })).toThrow(RangeError)
    expect(() =>
      peerData(
        frame(
          PeerCode.SearchResponse,
          new BinaryWriter().raw(
            deflateSync(new BinaryWriter().string('u').uint32(1).uint32(1).uint8(1).string('f').uint32(1).build()),
          ),
        ),
      ),
    ).toThrow(ProtocolError)
  })

  it('decodes initialization and distributed variants', () => {
    expect(decodeFrame('peer-init', peerInit.pierceFirewall(7))).toMatchObject({
      name: 'PierceFirewall',
      data: { token: 7 },
    })
    expect(decodeFrame('peer-init', peerInit.initialize('u', ConnectionType.Peer))).toMatchObject({
      data: { username: 'u', type: 'P', token: 0 },
    })
    expect(
      decodeFrame('peer-init', frame(PeerInitCode.PeerInit, new BinaryWriter().string('u').string('P'))).data,
    ).toEqual({ username: 'u', type: 'P' })
    expect(decodeFrame('peer-init', frame(9, new BinaryWriter().raw(Buffer.from('x')))).data).toEqual(Buffer.from('x'))
    expect(decodeFrame('distributed', frame(DistributedCode.Ping)).data).toEqual({})
    expect(
      decodeFrame(
        'distributed',
        frame(
          DistributedCode.Search,
          new BinaryWriter().uint32(49).string('u').uint32(1).string('q'),
        ),
      ).data,
    ).toEqual({ identifier: 49, username: 'u', token: 1, query: 'q' })
    expect(
      decodeFrame('distributed', frame(DistributedCode.BranchLevel, new BinaryWriter().int32(-1))).data,
    ).toEqual({ level: -1 })
    expect(
      decodeFrame('distributed', frame(DistributedCode.BranchRoot, new BinaryWriter().string('u'))).data,
    ).toEqual({ username: 'u' })
    expect(
      decodeFrame('distributed', frame(DistributedCode.ChildDepth, new BinaryWriter().uint32(2))).data,
    ).toEqual({ depth: 2 })
    expect(
      decodeFrame(
        'distributed',
        frame(DistributedCode.EmbeddedMessage, new BinaryWriter().raw(Buffer.from([0, 0, 0, 3, 9]))),
      ).data,
    ).toEqual({ code: 3, payload: Buffer.from([9]) })
    expect(
      decodeFrame(
        'distributed',
        frame(DistributedCode.EmbeddedMessage, new BinaryWriter().raw(Buffer.from([3, 9]))),
      ).data,
    ).toEqual({ code: 3, payload: Buffer.from([9]) })
    expect(decodeFrame('distributed', frame(99, new BinaryWriter().raw(Buffer.from('x')))).data).toEqual(Buffer.from('x'))
    expect(decodeFrame('server', frame(999)).name).toBe('Unknown(999)')
  })
})
