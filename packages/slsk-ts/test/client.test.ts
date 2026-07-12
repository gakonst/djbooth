import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net, { type AddressInfo, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LoginError, SoulseekClient, type SoulseekClientOptions } from '../src/client.js'
import { PeerConnection, PeerListener } from '../src/network/index.js'
import {
  BinaryReader,
  BinaryWriter,
  ConnectionType,
  DistributedCode,
  encodeFrame,
  FrameDecoder,
  PeerCode,
  peer,
  peerInit,
  ServerCode,
  type Address,
  type Frame,
  type ProtocolMessage,
} from '../src/protocol/index.js'

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).reverse().map((close) => close()))
})

class FakeSoulseekServer extends EventEmitter {
  readonly server: Server
  readonly frames: Frame[] = []
  readonly addresses = new Map<string, Address>()
  readonly sockets = new Set<Socket>()
  rejectLogin: string | undefined
  listenPort = 0

  constructor() {
    super()
    this.server = net.createServer((socket) => this.#connection(socket))
    this.server.on('error', (error) => this.emit('error', error))
  }

  async listen(): Promise<Address> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const info = this.server.address() as AddressInfo
    return { host: '127.0.0.1', port: info.port }
  }

  #connection(socket: Socket): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    const decoder = new FrameDecoder('server')
    socket.on('data', (chunk) => {
      for (const incoming of decoder.push(chunk)) void this.#frame(socket, incoming)
    })
  }

  async #frame(socket: Socket, incoming: Frame): Promise<void> {
    this.frames.push(incoming)
    this.emit('frame', incoming, socket)
    if (incoming.code === ServerCode.Login) {
      const writer = new BinaryWriter()
      if (this.rejectLogin) writer.bool(false).string(this.rejectLogin)
      else writer.bool(true).string('welcome').ipv4('127.0.0.1').string('checksum').bool(false)
      this.send(socket, ServerCode.Login, writer)
    } else if (incoming.code === ServerCode.SetListenPort) {
      this.listenPort = new BinaryReader(incoming.payload).uint32()
    } else if (incoming.code === ServerCode.GetPeerAddress) {
      const username = new BinaryReader(incoming.payload).string()
      const target = this.addresses.get(username)
      this.send(
        socket,
        ServerCode.GetPeerAddress,
        new BinaryWriter()
          .string(username)
          .ipv4(target?.host ?? '0.0.0.0')
          .uint32(target?.port ?? 0),
      )
    } else if (incoming.code === ServerCode.JoinRoom) {
      const room = new BinaryReader(incoming.payload).string()
      this.send(
        socket,
        ServerCode.JoinRoom,
        new BinaryWriter().string(room).uint32(0).uint32(0).uint32(0).uint32(0).uint32(0),
      )
    }
  }

  send(socket: Socket, code: number, writer = new BinaryWriter()): void {
    socket.write(encodeFrame('server', code, writer.build()))
  }

  broadcast(code: number, writer = new BinaryWriter()): void {
    for (const socket of this.sockets) this.send(socket, code, writer)
  }

  waitFor(code: number): Promise<Frame> {
    const existing = this.frames.find((item) => item.code === code)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => {
      const handler = (incoming: Frame) => {
        if (incoming.code === code) {
          this.off('frame', handler)
          resolve(incoming)
        }
      }
      this.on('frame', handler)
    })
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    if (this.server.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()))
    }
  }
}

async function fakeServer(): Promise<{ fake: FakeSoulseekServer; address: Address }> {
  const fake = new FakeSoulseekServer()
  const address = await fake.listen()
  cleanup.push(() => fake.close())
  return { fake, address }
}

async function clientFor(address: Address, options: SoulseekClientOptions = {}): Promise<SoulseekClient> {
  const client = new SoulseekClient({
    server: address,
    requestTimeout: 100,
    searchTimeout: 20,
    transferTimeout: 200,
    initialToken: 100,
    ...options,
  })
  client.on('clientError', () => {})
  cleanup.push(() => client.disconnect())
  await client.connect('local-user', 'password')
  return client
}

function waitForOutgoing(
  fake: FakeSoulseekServer,
  code: number,
  predicate: (frame: Frame) => boolean = () => true,
): Promise<Frame> {
  const existing = fake.frames.find((item) => item.code === code && predicate(item))
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve) => {
    const handler = (item: Frame) => {
      if (item.code === code && predicate(item)) {
        fake.off('frame', handler)
        resolve(item)
      }
    }
    fake.on('frame', handler)
  })
}

async function inboundPeer(client: SoulseekClient, username = 'remote'): Promise<PeerConnection> {
  const connected = once(client, 'peerConnected') as Promise<[PeerConnection]>
  const socket = net.createConnection({ host: '127.0.0.1', port: client.listener.address!.port })
  cleanup.push(() => {
    socket.destroy()
  })
  await once(socket, 'connect')
  const init = peerInit.initialize(username, ConnectionType.Peer)
  socket.write(encodeFrame('peer-init', init.code, init.payload))
  const remote = new PeerConnection(socket, 'local-user', ConnectionType.Peer)
  await connected
  return remote
}

async function readBytes(socket: Socket, length: number): Promise<Buffer> {
  let buffered: Buffer = Buffer.alloc(0)
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      if (buffered.length >= length) {
        socket.pause()
        socket.off('data', onData)
        socket.off('error', onError)
        const remainder = buffered.subarray(length)
        if (remainder.length > 0) socket.unshift(remainder)
        resolve(buffered.subarray(0, length))
      }
    }
    const onError = (error: Error) => reject(error)
    socket.on('data', onData)
    socket.once('error', onError)
    socket.resume()
  })
}

describe('SoulseekClient lifecycle and server API', () => {
  it('connects, announces state, handles server events, and sends public APIs', async () => {
    const { fake, address } = await fakeServer()
    const client = await clientFor(address)
    expect(client.state).toBe('connected')
    expect(client.username).toBe('local-user')
    await fake.waitFor(ServerCode.HaveNoParent)
    expect(fake.frames.slice(0, 5).map(({ code }) => code)).toEqual([
      ServerCode.Login,
      ServerCode.SetListenPort,
      ServerCode.SharedCounts,
      ServerCode.SetStatus,
      ServerCode.HaveNoParent,
    ])

    const privateMessage = once(client, 'privateMessage')
    fake.broadcast(
      ServerCode.MessageUser,
      new BinaryWriter().uint32(9).uint32(1).string('alice').string('hello').bool(true),
    )
    expect((await privateMessage)[0]).toMatchObject({ id: 9, username: 'alice' })
    await fake.waitFor(ServerCode.MessageAcknowledged)

    const roomMessage = once(client, 'roomMessage')
    fake.broadcast(ServerCode.SayChatroom, new BinaryWriter().string('room').string('alice').string('hi'))
    expect((await roomMessage)[0]).toMatchObject({ room: 'room', message: 'hi' })
    const excluded = new Promise<void>((resolve) => {
      const handler = (message: ProtocolMessage) => {
        if (message.code === ServerCode.ExcludedSearchPhrases) {
          client.off('serverMessage', handler)
          resolve()
        }
      }
      client.on('serverMessage', handler)
    })
    fake.broadcast(ServerCode.ExcludedSearchPhrases, new BinaryWriter().uint32(1).string('forbidden'))
    await excluded
    expect(client.excludedSearchPhrases).toEqual(['forbidden'])

    expect(await client.joinRoom('room')).toMatchObject({ room: 'room' })
    await client.leaveRoom('room')
    await client.sendPrivateMessage('alice', 'hello')
    await client.sendRoomMessage('room', 'hello')
    await client.send(serverFrame(999))
    await fake.waitFor(999)
    expect(fake.frames.at(-1)?.code).toBe(999)

    await expect(client.getPeerAddress('offline')).rejects.toThrow('offline')
    await client.disconnect()
    expect(client.state).toBe('disconnected')
    expect(client.username).toBeUndefined()
    await client.disconnect()
    await expect(client.send(serverFrame(1))).rejects.toThrow('not connected')
    await expect(client.openPeer('x')).rejects.toThrow('not connected')
    await expect(client.search('x')).rejects.toThrow('not connected')
  })

  it('validates construction and connection state and reports login/network failures', async () => {
    expect(() => new SoulseekClient({ uploadSlots: -1 })).toThrow(RangeError)
    const { fake, address } = await fakeServer()
    const client = new SoulseekClient({ server: address, requestTimeout: 30 })
    cleanup.push(() => client.disconnect())
    await expect(client.connect('', 'password')).rejects.toThrow(TypeError)
    const connecting = client.connect('u', 'p')
    await expect(client.connect('u', 'p')).rejects.toThrow('while connecting')
    await connecting
    await expect(client.connect('u', 'p')).rejects.toThrow('while connected')
    await client.disconnect()

    fake.rejectLogin = 'INVALIDPASS'
    const rejected = new SoulseekClient({ server: address, requestTimeout: 30 })
    cleanup.push(() => rejected.disconnect())
    await expect(rejected.connect('u2', 'bad')).rejects.toEqual(new LoginError('INVALIDPASS'))
    expect(rejected.state).toBe('disconnected')

    const unavailable = new SoulseekClient({ server: { host: '127.0.0.1', port: 1 }, requestTimeout: 20 })
    cleanup.push(() => unavailable.disconnect())
    await expect(unavailable.connect('u', 'p')).rejects.toBeInstanceOf(Error)
    expect(unavailable.state).toBe('disconnected')
  })

  it('supports disabling automatic private-message acknowledgement', async () => {
    const { fake, address } = await fakeServer()
    const client = await clientFor(address, { autoAcknowledge: false })
    const received = once(client, 'privateMessage')
    fake.broadcast(
      ServerCode.MessageUser,
      new BinaryWriter().uint32(9).uint32(1).string('alice').string('hello').bool(true),
    )
    await received
    expect(fake.frames.some(({ code }) => code === ServerCode.MessageAcknowledged)).toBe(false)
    await client.disconnect()
  })

  it('forwards listener, server, and peer errors and notices an unexpected server close', async () => {
    const { fake, address } = await fakeServer()
    const client = await clientFor(address)
    await fake.waitFor(ServerCode.HaveNoParent)
    const listenerError = once(client, 'clientError')
    client.listener.emit('error', new Error('listener error'))
    expect((await listenerError)[0]).toMatchObject({ message: 'listener error' })

    const handshakeError = once(client, 'clientError')
    const malformed = net.createConnection({ host: '127.0.0.1', port: fake.listenPort })
    malformed.write(Buffer.from([0, 0, 0, 0]))
    expect((await handshakeError)[0]).toBeInstanceOf(Error)
    malformed.destroy()

    const serverError = once(client, 'clientError')
    client.serverConnection!.socket.emit('error', new Error('server socket error'))
    expect((await serverError)[0]).toMatchObject({ message: 'server socket error' })

    const remote = await inboundPeer(client, 'errored-peer')
    const peerError = once(client, 'clientError')
    client.peers.get('errored-peer')!.socket.emit('error', new Error('peer socket error'))
    expect((await peerError)[0]).toMatchObject({ message: 'peer socket error' })
    remote.destroy()

    const disconnected = once(client, 'state')
    for (const socket of fake.sockets) socket.destroy()
    expect((await disconnected)[0]).toBe('disconnected')
  })

  it('passes connection abort/version options and cleans pending operations on disconnect', async () => {
    const { fake, address } = await fakeServer()
    const client = new SoulseekClient({
      server: address,
      requestTimeout: 100,
      transferTimeout: 1_000,
      initialToken: 100,
    })
    client.on('clientError', () => {})
    cleanup.push(() => client.disconnect())
    const controller = new AbortController()
    await client.connect('options-user', 'password', {
      signal: controller.signal,
      majorVersion: 178,
      minorVersion: 9,
    })
    const login = new BinaryReader(fake.frames[0]!.payload)
    login.string()
    login.string()
    expect(login.uint32()).toBe(178)

    fake.addresses.set('pending', { host: '127.0.0.1', port: 1 })
    const pending = client.openPeer('pending')
    void pending.catch(() => {})
    await waitForOutgoing(fake, ServerCode.ConnectToPeer, (item) => {
      const reader = new BinaryReader(item.payload)
      reader.uint32()
      return reader.string() === 'pending'
    })

    const fileSocket = net.createConnection({ host: '127.0.0.1', port: fake.listenPort })
    await once(fileSocket, 'connect')
    const fileInit = peerInit.initialize('file-user', ConnectionType.File)
    fileSocket.write(encodeFrame('peer-init', fileInit.code, fileInit.payload))
    await new Promise((resolve) => setImmediate(resolve))

    const rejected = expect(pending).rejects.toThrow('disconnected')
    await client.disconnect()
    await rejected
    fileSocket.destroy()
  })
})

function serverFrame(code: number, writer = new BinaryWriter()): Frame {
  return { code, payload: writer.build() }
}

describe('search collection', () => {
  it('collects direct peer results and supports global, user, and room scopes', async () => {
    const { fake, address } = await fakeServer()
    const client = await clientFor(address)
    const resultsPromise = client.search('track', { timeout: 200, maxResults: 1 })
    const searchFrame = await fake.waitFor(ServerCode.FileSearch)
    const token = new BinaryReader(searchFrame.payload).uint32()
    const socket = net.createConnection({ host: '127.0.0.1', port: fake.listenPort })
    cleanup.push(() => {
      socket.destroy()
    })
    await once(socket, 'connect')
    const init = peerInit.initialize('remote', ConnectionType.Peer)
    const result = peer.searchResponse({
      username: 'remote',
      token,
      files: [{ code: 1, filename: 'Music\\track.flac', size: 3n, attributes: {} }],
      freeUploadSlots: true,
      uploadSpeed: 100,
      queueLength: 0,
    })
    socket.write(
      Buffer.concat([
        encodeFrame('peer-init', init.code, init.payload),
        encodeFrame('peer', result.code, result.payload),
      ]),
    )
    expect(await resultsPromise).toMatchObject([{ username: 'remote', files: [{ size: 3n }] }])
    const remote = new PeerConnection(socket, 'local-user', ConnectionType.Peer)
    remote.on('error', () => {})
    await remote.send(
      peer.searchResponse({
        username: 'remote',
        token: 999,
        files: [],
        freeUploadSlots: false,
        uploadSpeed: 0,
        queueLength: 0,
      }),
    )
    const partialPromise = client.search('partial', { timeout: 5, maxResults: 2 })
    const partialFrame = await waitForOutgoing(fake, ServerCode.FileSearch, (item) => {
      const reader = new BinaryReader(item.payload)
      reader.uint32()
      return reader.string() === 'partial'
    })
    const partialToken = new BinaryReader(partialFrame.payload).uint32()
    await remote.send(
      peer.searchResponse({
        username: 'remote',
        token: partialToken,
        files: [],
        freeUploadSlots: false,
        uploadSpeed: 0,
        queueLength: 0,
      }),
    )
    expect(await partialPromise).toHaveLength(1)
    expect(await client.search('none', { user: 'alice', timeout: 20 })).toEqual([])
    expect(fake.frames.some(({ code }) => code === ServerCode.UserSearch)).toBe(true)
    expect(await client.search('none', { room: 'room', timeout: 20 })).toEqual([])
    expect(fake.frames.some(({ code }) => code === ServerCode.RoomSearch)).toBe(true)
    remote.destroy()
  })

  it('validates scope and aborts or disconnects active searches', async () => {
    const { address } = await fakeServer()
    const client = await clientFor(address)
    await expect(client.search('   ')).rejects.toThrow('cannot be empty')
    await expect(client.search('x', { user: 'a', room: 'b' })).rejects.toThrow('mutually exclusive')
    const aborted = new AbortController()
    aborted.abort()
    await expect(client.search('x', { signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const later = new AbortController()
    const pendingAbort = client.search('x', { timeout: 1_000, signal: later.signal })
    later.abort()
    await expect(pendingAbort).rejects.toMatchObject({ name: 'AbortError' })
    const pendingDisconnect = client.search('x', { timeout: 1_000 })
    await client.disconnect()
    await expect(pendingDisconnect).rejects.toThrow('disconnected')
  })

  it('uses the default timeout and wraps protocol tokens', async () => {
    const { fake, address } = await fakeServer()
    const client = await clientFor(address, { searchTimeout: 2, initialToken: 0xffff_ffff })
    expect(await client.search('wrapped')).toEqual([])
    const outgoing = await waitForOutgoing(fake, ServerCode.FileSearch)
    expect(new BinaryReader(outgoing.payload).uint32()).toBe(1)
  })
})

describe('peer APIs and inbound service responses', () => {
  it('opens and caches a direct peer, then browses and fetches user info', async () => {
    const { fake, address } = await fakeServer()
    const listener = new PeerListener()
    const peerAddressInfo = await listener.listen(0, '127.0.0.1')
    cleanup.push(() => listener.close())
    fake.addresses.set('remote', { host: '127.0.0.1', port: peerAddressInfo.port })
    listener.on('connection', ({ socket, initialization }) => {
      const remote = PeerConnection.fromIncoming(socket, initialization)
      remote.on('error', () => {})
      remote.on('message', (message: ProtocolMessage) => {
        if (message.code === PeerCode.BrowseRequest) {
          void remote.send(peer.browseResponse([{ directory: 'Music', files: [] }]))
        } else if (message.code === PeerCode.InfoRequest) {
          void remote.send(
            peer.infoResponse({
              description: 'profile',
              totalUploads: 1,
              queueSize: 0,
              slotsAvailable: true,
              uploadPermission: 0,
            }),
          )
        }
      })
      cleanup.push(() => remote.destroy())
    })
    const client = await clientFor(address)
    const opened = await client.openPeer('remote')
    expect(await client.openPeer('remote')).toBe(opened)
    const signal = new AbortController().signal
    expect(await client.browse('remote', signal)).toMatchObject({ publicFolders: [{ directory: 'Music' }] })
    expect(await client.userInfo('remote', signal)).toMatchObject({ description: 'profile' })
    expect(await client.browse('remote')).toMatchObject({ publicFolders: [{ directory: 'Music' }] })
    expect(await client.userInfo('remote')).toMatchObject({ description: 'profile' })
  })

  it('serves browse, info, folder, search, queue, and legacy transfer requests', async () => {
    const { address } = await fakeServer()
    const client = await clientFor(address, { uploadSlots: 0, description: 'local profile', picture: Buffer.from('pic') })
    const root = await mkdtemp(path.join(tmpdir(), 'slsk-client-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const filename = path.join(root, 'track.flac')
    await writeFile(filename, 'abc')
    await client.shares.addFile(filename, 'Music\\track.flac')
    const remote = await inboundPeer(client)

    const orphan = peer.searchResponse({
      username: 'remote',
      token: 999,
      files: [],
      freeUploadSlots: false,
      uploadSpeed: 0,
      queueLength: 0,
    })
    await remote.send(orphan)

    const browse = remote.waitFor((message) => message.code === PeerCode.BrowseResponse)
    await remote.send(peer.browseRequest())
    expect((await browse).data).toMatchObject({ publicFolders: [{ directory: 'Music' }] })

    const info = remote.waitFor((message) => message.code === PeerCode.InfoResponse)
    await remote.send(peer.infoRequest())
    expect((await info).data).toMatchObject({ description: 'local profile', picture: Buffer.from('pic') })

    const folder = remote.waitFor((message) => message.code === PeerCode.FolderContentsResponse)
    await remote.send(peer.folderContentsRequest(7, 'Music'))
    expect((await folder).data).toMatchObject({ token: 7, folders: [{ directory: 'Music' }] })

    const search = remote.waitFor((message) => message.code === PeerCode.SearchResponse)
    await remote.send(peer.searchRequest(8, 'track'))
    expect((await search).data).toMatchObject({ token: 8, publicFiles: [{ filename: 'Music\\track.flac' }] })
    await remote.send(peer.searchRequest(9, 'absent'))

    const denied = remote.waitFor((message) => message.code === PeerCode.UploadDenied)
    await remote.send(peer.queueUpload('missing'))
    expect((await denied).data).toMatchObject({ reason: 'File not shared.' })

    await remote.send(peer.queueUpload('Music\\track.flac'))
    await remote.send(peer.queueUpload('Music\\track.flac'))
    const place = remote.waitFor((message) => message.code === PeerCode.PlaceInQueueResponse)
    await remote.send(peer.placeInQueueRequest('Music\\track.flac'))
    expect((await place).data).toMatchObject({ place: 1 })
    const missingPlace = remote.waitFor((message) => message.code === PeerCode.PlaceInQueueResponse)
    await remote.send(peer.placeInQueueRequest('other'))
    expect((await missingPlace).data).toMatchObject({ place: 0 })

    const legacy = remote.waitFor((message) => message.code === PeerCode.TransferResponse)
    await remote.send(peer.transferRequest(0, 55, 'Music\\track.flac'))
    expect((await legacy).data).toMatchObject({ token: 55, allowed: false, reason: 'Queued' })
    const clientPeer = client.peers.get('remote')!
    clientPeer.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    const backgroundError = once(client, 'clientError')
    const browseRequest = peer.browseRequest()
    clientPeer.socket.emit('data', encodeFrame('peer', browseRequest.code, browseRequest.payload))
    expect((await backgroundError)[0]).toMatchObject({ message: 'Socket is closed' })
    remote.destroy()
  })

  it('rejects unknown inbound handshakes and duplicate peer sessions', async () => {
    const { address } = await fakeServer()
    const client = await clientFor(address)
    const first = await inboundPeer(client, 'duplicate')
    const secondSocket = net.createConnection({ host: '127.0.0.1', port: client.listener.address!.port })
    cleanup.push(() => {
      secondSocket.destroy()
    })
    await once(secondSocket, 'connect')
    const init = peerInit.initialize('duplicate', ConnectionType.Peer)
    secondSocket.write(encodeFrame('peer-init', init.code, init.payload))
    await once(secondSocket, 'close')
    expect(client.peers.size).toBe(1)

    const unknown = net.createConnection({ host: '127.0.0.1', port: client.listener.address!.port })
    cleanup.push(() => {
      unknown.destroy()
    })
    await once(unknown, 'connect')
    unknown.write(encodeFrame('peer-init', 99, Buffer.alloc(0)))
    await once(unknown, 'close')

    const pierce = net.createConnection({ host: '127.0.0.1', port: client.listener.address!.port })
    cleanup.push(() => {
      pierce.destroy()
    })
    await once(pierce, 'connect')
    const firewall = peerInit.pierceFirewall(999)
    pierce.write(encodeFrame('peer-init', firewall.code, firewall.payload))
    await once(pierce, 'close')
    first.destroy()
  })

  it('serves profile responses without pictures', async () => {
    const { address } = await fakeServer()
    const client = await clientFor(address)
    const remote = await inboundPeer(client)
    const info = remote.waitFor((message) => message.code === PeerCode.InfoResponse)
    await remote.send(peer.infoRequest())
    expect((await info).data).toMatchObject({ hasPicture: false })
    remote.destroy()
  })
})

describe('direct, indirect, and server-requested connections', () => {
  it('falls back to an indirect peer connection and supports timeout and abort', async () => {
    const { fake, address } = await fakeServer()
    fake.addresses.set('indirect', { host: '127.0.0.1', port: 1 })
    const client = await clientFor(address, { requestTimeout: 30 })
    let remote: PeerConnection | undefined
    fake.on('frame', (incoming: Frame) => {
      if (incoming.code !== ServerCode.ConnectToPeer) return
      const reader = new BinaryReader(incoming.payload)
      const token = reader.uint32()
      const username = reader.string()
      const type = reader.string()
      if (username !== 'indirect') return
      const socket = net.createConnection({ host: '127.0.0.1', port: fake.listenPort })
      socket.once('connect', () => {
        const init = peerInit.pierceFirewall(token)
        socket.write(encodeFrame('peer-init', init.code, init.payload))
        remote = new PeerConnection(socket, 'local-user', type as ConnectionType)
        remote.on('error', () => {})
      })
      cleanup.push(() => {
        socket.destroy()
      })
    })
    const opened = await client.openPeer('indirect')
    expect(opened.username).toBe('indirect')
    expect(remote).toBeDefined()

    fake.addresses.set('timeout', { host: '127.0.0.1', port: 1 })
    await expect(client.openPeer('timeout')).rejects.toThrow('Indirect connection')

    fake.addresses.set('abort', { host: '127.0.0.1', port: 1 })
    const controller = new AbortController()
    const pending = client.openPeer('abort', controller.signal)
    await waitForOutgoing(fake, ServerCode.ConnectToPeer, (item) => {
      const reader = new BinaryReader(item.payload)
      reader.uint32()
      return reader.string() === 'abort'
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    const preAborted = new AbortController()
    preAborted.abort()
    await expect(client.openPeer('pre-aborted', preAborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('handles inbound ConnectToPeer requests for peer and file sockets and reports failures', async () => {
    const { fake, address } = await fakeServer()
    const client = await clientFor(address, { transferTimeout: 20 })
    const requester = new PeerListener()
    const requesterAddress = await requester.listen(0, '127.0.0.1')
    cleanup.push(() => requester.close())
    const peerIncoming = once(requester, 'connection') as Promise<[{ initialization: ProtocolMessage }]>
    fake.broadcast(
      ServerCode.ConnectToPeer,
      new BinaryWriter()
        .string('requester')
        .string(ConnectionType.Peer)
        .ipv4('127.0.0.1')
        .uint32(requesterAddress.port)
        .uint32(77)
        .bool(false),
    )
    expect((await peerIncoming)[0].initialization).toMatchObject({
      code: 0,
      data: { token: 77 },
    })

    const rawServer = net.createServer((socket) => {
      const decoder = new FrameDecoder('peer-init')
      socket.on('data', (chunk) => {
        if (decoder.push(chunk).length > 0) socket.write(new BinaryWriter().uint32(999).build())
      })
    })
    rawServer.listen(0, '127.0.0.1')
    await once(rawServer, 'listening')
    cleanup.push(
      () => new Promise<void>((resolve) => rawServer.close(() => resolve())),
    )
    const rawAddress = rawServer.address() as AddressInfo
    fake.broadcast(
      ServerCode.ConnectToPeer,
      new BinaryWriter()
        .string('raw-user')
        .string(ConnectionType.File)
        .ipv4('127.0.0.1')
        .uint32(rawAddress.port)
        .uint32(78)
        .bool(false),
    )
    await new Promise((resolve) => setTimeout(resolve, 5))

    fake.broadcast(
      ServerCode.ConnectToPeer,
      new BinaryWriter()
        .string('failed')
        .string(ConnectionType.Peer)
        .ipv4('127.0.0.1')
        .uint32(1)
        .uint32(79)
        .bool(false),
    )
    await fake.waitFor(ServerCode.CannotConnectToPeer)
    expect(client.state).toBe('connected')
  })

  it('responds to server and distributed searches, including ignored and failed responses', async () => {
    const { fake, address } = await fakeServer()
    const client = await clientFor(address)
    const root = await mkdtemp(path.join(tmpdir(), 'slsk-search-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const local = path.join(root, 'track.flac')
    await writeFile(local, 'abc')
    await client.shares.addFile(local, 'Music\\track.flac')

    const listener = new PeerListener()
    const peerAddress = await listener.listen(0, '127.0.0.1')
    cleanup.push(() => listener.close())
    fake.addresses.set('searcher', { host: '127.0.0.1', port: peerAddress.port })
    const response = new Promise<ProtocolMessage>((resolve) => {
      listener.on('connection', ({ socket, initialization }) => {
        const connection = PeerConnection.fromIncoming(socket, initialization)
        connection.on('message', resolve)
        cleanup.push(() => connection.destroy())
      })
    })
    fake.broadcast(ServerCode.FileSearch, new BinaryWriter().string('searcher').uint32(12).string('track'))
    expect(await response).toMatchObject({ code: PeerCode.SearchResponse, data: { token: 12 } })

    fake.broadcast(ServerCode.FileSearch, new BinaryWriter().string('local-user').uint32(13).string('track'))
    fake.broadcast(ServerCode.FileSearch, new BinaryWriter().string('searcher').uint32(14).string('absent'))
    fake.addresses.set('unreachable', { host: '127.0.0.1', port: 1 })
    fake.broadcast(ServerCode.FileSearch, new BinaryWriter().string('unreachable').uint32(15).string('track'))
    await new Promise((resolve) => setTimeout(resolve, 120))

    const distributedTarget = new PeerListener()
    const targetAddress = await distributedTarget.listen(0, '127.0.0.1')
    cleanup.push(() => distributedTarget.close())
    fake.addresses.set('distributed-searcher', { host: '127.0.0.1', port: targetAddress.port })
    const distributedResponse = new Promise<ProtocolMessage>((resolve) => {
      distributedTarget.on('connection', ({ socket, initialization }) => {
        const connection = PeerConnection.fromIncoming(socket, initialization)
        connection.on('message', resolve)
        cleanup.push(() => connection.destroy())
      })
    })
    const parentConnected = once(client, 'peerConnected')
    const parentSocket = net.createConnection({ host: '127.0.0.1', port: fake.listenPort })
    await once(parentSocket, 'connect')
    const parentInit = peerInit.initialize('parent', ConnectionType.Distributed)
    parentSocket.write(encodeFrame('peer-init', parentInit.code, parentInit.payload))
    await parentConnected
    const parent = new PeerConnection(parentSocket, 'local-user', ConnectionType.Distributed)
    await parent.send(
      serverFrame(
        3,
        new BinaryWriter().uint32(49).string('distributed-searcher').uint32(16).string('track'),
      ),
    )
    expect(await distributedResponse).toMatchObject({ code: PeerCode.SearchResponse, data: { token: 16 } })
    parent.destroy()
  })

  it('handles fragmented, ended, reset, and timed-out raw file handshakes', async () => {
    const { fake, address } = await fakeServer()
    // Keep the fragmented invalid-token path deterministic under loaded CI runners.
    const client = await clientFor(address, { transferTimeout: 1_000 })
    await fake.waitFor(ServerCode.HaveNoParent)
    const makeFileSocket = async () => {
      const accepted = once(client.listener, 'connection')
      const socket = net.createConnection({ host: '127.0.0.1', port: fake.listenPort })
      socket.on('error', () => {})
      socket.setNoDelay(true)
      await once(socket, 'connect')
      const init = peerInit.initialize('raw-test', ConnectionType.File)
      socket.write(encodeFrame('peer-init', init.code, init.payload))
      await accepted
      return socket
    }

    const fragmented = await makeFileSocket()
    fragmented.write(Buffer.from([1, 0]))
    await new Promise((resolve) => setTimeout(resolve, 10))
    fragmented.write(Buffer.from([0, 0, 9]))
    await new Promise((resolve) => setTimeout(resolve, 10))
    fragmented.destroy()

    const endedError = once(client, 'clientError')
    const ended = await makeFileSocket()
    ended.end()
    expect((await endedError)[0]).toBeInstanceOf(Error)

    const timeoutError = once(client, 'clientError')
    const idle = await makeFileSocket()
    expect((await timeoutError)[0]).toBeInstanceOf(Error)
    idle.destroy()
  })

  it('adopts, uses, forwards, and resets a distributed parent connection', async () => {
    const { fake, address } = await fakeServer()
    const client = await clientFor(address)
    const parentListener = new PeerListener()
    const parentAddress = await parentListener.listen(0, '127.0.0.1')
    cleanup.push(() => parentListener.close())
    const parentIncoming = once(parentListener, 'connection') as Promise<[
      { socket: Socket; initialization: ProtocolMessage },
    ]>
    fake.broadcast(
      ServerCode.PossibleParents,
      new BinaryWriter()
        .uint32(2)
        .string('bad-parent')
        .ipv4('127.0.0.1')
        .uint32(1)
        .string('parent')
        .ipv4('127.0.0.1')
        .uint32(parentAddress.port),
    )
    const [{ socket, initialization }] = await parentIncoming
    const parent = PeerConnection.fromIncoming(socket, initialization)
    parent.on('error', () => {})
    cleanup.push(() => parent.destroy())
    expect(client.distributedPeers.size).toBe(1)

    fake.broadcast(
      ServerCode.PossibleParents,
      new BinaryWriter().uint32(1).string('ignored').ipv4('127.0.0.1').uint32(1),
    )
    await parent.send(serverFrame(4, new BinaryWriter().int32(2)))
    await waitForOutgoing(fake, ServerCode.BranchLevel)
    await waitForOutgoing(fake, ServerCode.HaveNoParent, (item) => new BinaryReader(item.payload).bool() === false)
    await parent.send(serverFrame(5, new BinaryWriter().string('root-user')))
    await waitForOutgoing(fake, ServerCode.BranchRoot)

    const childConnected = once(client, 'peerConnected')
    const childSocket = net.createConnection({ host: '127.0.0.1', port: fake.listenPort })
    await once(childSocket, 'connect')
    const childInit = peerInit.initialize('child', ConnectionType.Distributed)
    childSocket.write(encodeFrame('peer-init', childInit.code, childInit.payload))
    await childConnected
    const child = new PeerConnection(childSocket, 'local-user', ConnectionType.Distributed)
    child.on('error', () => {})
    cleanup.push(() => child.destroy())

    const forwarded = child.waitFor((message) => message.code === DistributedCode.Search)
    await parent.send(
      serverFrame(3, new BinaryWriter().uint32(49).string('local-user').uint32(31).string('none')),
    )
    expect(await forwarded).toMatchObject({ data: { token: 31 } })
    await child.send(serverFrame(4, new BinaryWriter().int32(9)))
    await child.send(serverFrame(5, new BinaryWriter().string('ignored-root')))
    await child.send(serverFrame(99))

    fake.broadcast(ServerCode.EmbeddedMessage, new BinaryWriter().uint8(99))
    const embeddedForward = parent.waitFor((message) => message.code === DistributedCode.Search)
    fake.broadcast(
      ServerCode.EmbeddedMessage,
      new BinaryWriter()
        .uint8(DistributedCode.Search)
        .uint32(49)
        .string('local-user')
        .uint32(32)
        .string('none'),
    )
    expect(await embeddedForward).toMatchObject({ data: { token: 32 } })

    const resetSent = new Promise<Frame>((resolve) => {
      const handler = (item: Frame) => {
        if (item.code === ServerCode.HaveNoParent && new BinaryReader(item.payload).bool()) {
          fake.off('frame', handler)
          resolve(item)
        }
      }
      fake.on('frame', handler)
    })
    fake.broadcast(ServerCode.ResetDistributed)
    await resetSent
    expect(client.distributedPeers.size).toBe(0)

    const parentFailure = once(client, 'clientError')
    fake.broadcast(
      ServerCode.PossibleParents,
      new BinaryWriter().uint32(1).string('bad').ipv4('127.0.0.1').uint32(1),
    )
    expect((await parentFailure)[0]).toBeInstanceOf(Error)

    const secondIncoming = once(parentListener, 'connection') as Promise<[
      { socket: Socket; initialization: ProtocolMessage },
    ]>
    fake.broadcast(
      ServerCode.PossibleParents,
      new BinaryWriter()
        .uint32(1)
        .string('second-parent')
        .ipv4('127.0.0.1')
        .uint32(parentAddress.port),
    )
    const [{ socket: secondSocket, initialization: secondInit }] = await secondIncoming
    const secondParent = PeerConnection.fromIncoming(secondSocket, secondInit)
    secondParent.on('error', () => {})
    cleanup.push(() => secondParent.destroy())
    const distributedError = once(client, 'clientError')
    const clientSideParent = [...client.distributedPeers][0]!
    clientSideParent.socket.emit('error', new Error('distributed socket error'))
    expect((await distributedError)[0]).toMatchObject({ message: 'distributed socket error' })
    clientSideParent.destroy()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(client.distributedPeers.size).toBe(0)
    fake.broadcast(ServerCode.PossibleParents, new BinaryWriter().uint32(0))
  })
})

describe('downloads and uploads', () => {
  async function downloadPeer(
    fake: FakeSoulseekServer,
    content: Buffer,
    behavior: 'success' | 'deny' | 'short' | 'long' | 'no-file' = 'success',
  ): Promise<{ listener: PeerListener; offsets: bigint[] }> {
    const listener = new PeerListener()
    const info = await listener.listen(0, '127.0.0.1')
    cleanup.push(() => listener.close())
    fake.addresses.set('downloader-peer', { host: '127.0.0.1', port: info.port })
    const offsets: bigint[] = []
    listener.on('connection', ({ socket, initialization }) => {
      const connection = PeerConnection.fromIncoming(socket, initialization)
      cleanup.push(() => connection.destroy())
      connection.on('message', (message: ProtocolMessage) => {
        if (message.code === PeerCode.QueueUpload) {
          if (behavior === 'deny') {
            void connection.send(peer.uploadDenied('Music\\track.flac', 'Banned'))
          } else {
            void connection.send(peer.transferRequest(1, 444, 'Music\\track.flac', BigInt(content.length)))
          }
        } else if (message.code === PeerCode.TransferResponse && behavior !== 'no-file') {
          const fileSocket = net.createConnection({ host: '127.0.0.1', port: fake.listenPort })
          cleanup.push(() => {
            fileSocket.destroy()
          })
          fileSocket.once('connect', () => {
            void (async () => {
            const init = peerInit.initialize('downloader-peer', ConnectionType.File)
            fileSocket.write(
              Buffer.concat([
                encodeFrame('peer-init', init.code, init.payload),
                new BinaryWriter().uint32(444).build(),
              ]),
            )
            const offset = new BinaryReader(await readBytes(fileSocket, 8)).uint64()
            offsets.push(offset)
            const remaining = content.subarray(Number(offset))
            fileSocket.end(
              behavior === 'short'
                ? remaining.subarray(0, -1)
                : behavior === 'long'
                  ? Buffer.concat([remaining, Buffer.from('!')])
                  : remaining,
            )
            })().catch(() => {})
          })
        }
      })
    })
    return { listener, offsets }
  }

  it('downloads new files, reports progress, and rejects denials and short streams', async () => {
    const { fake, address } = await fakeServer()
    const client = await clientFor(address, { transferTimeout: 50 })
    const root = await mkdtemp(path.join(tmpdir(), 'slsk-download-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const destination = path.join(root, 'track.flac')
    const progress: number[] = []
    const successful = await downloadPeer(fake, Buffer.from('abcd'))
    const controller = new AbortController()
    const result = await client.download('downloader-peer', 'Music\\track.flac', destination, {
      onProgress: ({ percent }) => progress.push(percent),
      signal: controller.signal,
    })
    expect(result).toMatchObject({ size: 4n, received: 4n, resumedFrom: 0n })
    expect(successful.offsets).toEqual([0n])
    expect(await readFile(destination, 'utf8')).toBe('abcd')
    expect(progress.at(-1)).toBe(100)

    client.peers.get('downloader-peer')?.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    await successful.listener.close()
    const denied = await downloadPeer(fake, Buffer.from('abcd'), 'deny')
    await expect(client.download('downloader-peer', 'Music\\track.flac', destination)).rejects.toThrow('Banned')
    client.peers.get('downloader-peer')?.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    await denied.listener.close()

    const short = await downloadPeer(fake, Buffer.from('abcd'), 'short')
    await expect(
      client.download('downloader-peer', 'Music\\track.flac', path.join(root, 'short.flac')),
    ).rejects.toThrow('size mismatch')
    client.peers.get('downloader-peer')?.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    await short.listener.close()

    const long = await downloadPeer(fake, Buffer.from('abcd'), 'long')
    await expect(
      client.download('downloader-peer', 'Music\\track.flac', path.join(root, 'long.flac')),
    ).rejects.toThrow('exceeded declared size')
    client.peers.get('downloader-peer')?.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    await long.listener.close()

    const badPathPeer = await downloadPeer(fake, Buffer.from('abcd'))
    await expect(
      client.download('downloader-peer', 'Music\\track.flac', path.join(root, 'bad-path.flac'), {
        temporaryPath: path.join(root, 'x'.repeat(5_000)),
      }),
    ).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
    client.peers.get('downloader-peer')?.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    await badPathPeer.listener.close()
  })

  it('resumes, restarts oversized partials, disables resume, and times out raw file sockets', async () => {
    const { fake, address } = await fakeServer()
    const client = await clientFor(address, { transferTimeout: 20 })
    const root = await mkdtemp(path.join(tmpdir(), 'slsk-resume-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))

    let active = await downloadPeer(fake, Buffer.from('abcd'))
    const resumed = path.join(root, 'resumed.flac')
    await writeFile(`${resumed}.part`, 'ab')
    expect(await client.download('downloader-peer', 'Music\\track.flac', resumed)).toMatchObject({ resumedFrom: 2n })
    expect(active.offsets).toEqual([2n])
    client.peers.get('downloader-peer')?.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    await active.listener.close()

    active = await downloadPeer(fake, Buffer.from('abcd'))
    const oversized = path.join(root, 'oversized.flac')
    await writeFile(`${oversized}.part`, 'too-large')
    expect(await client.download('downloader-peer', 'Music\\track.flac', oversized)).toMatchObject({ resumedFrom: 0n })
    client.peers.get('downloader-peer')?.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    await active.listener.close()

    active = await downloadPeer(fake, Buffer.from('abcd'))
    const restart = path.join(root, 'restart.flac')
    await writeFile(`${restart}.part`, 'ab')
    expect(
      await client.download('downloader-peer', 'Music\\track.flac', restart, { resume: false }),
    ).toMatchObject({ resumedFrom: 0n })
    client.peers.get('downloader-peer')?.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    await active.listener.close()

    active = await downloadPeer(fake, Buffer.from('abcd'), 'no-file')
    await expect(
      client.download('downloader-peer', 'Music\\track.flac', path.join(root, 'timeout.flac')),
    ).rejects.toThrow('timed out')
    client.peers.get('downloader-peer')?.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    await active.listener.close()
  })

  it('rejects a pending raw download when the client disconnects', async () => {
    const { fake, address } = await fakeServer()
    const client = await clientFor(address, { transferTimeout: 1_000 })
    const root = await mkdtemp(path.join(tmpdir(), 'slsk-pending-download-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const active = await downloadPeer(fake, Buffer.from('abcd'), 'no-file')
    const pending = client.download(
      'downloader-peer',
      'Music\\track.flac',
      path.join(root, 'pending.flac'),
    )
    void pending.catch(() => {})
    const connection = await waitForOutgoing(fake, ServerCode.GetPeerAddress)
    expect(connection.code).toBe(ServerCode.GetPeerAddress)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const rejected = expect(pending).rejects.toThrow('disconnected')
    await client.disconnect()
    await rejected
    await active.listener.close()
  })

  it('serves queued uploads, handles rejection, resume offsets, and invalid offsets', async () => {
    const { fake, address } = await fakeServer()
    const raw = new PeerListener()
    const rawAddress = await raw.listen(0, '127.0.0.1')
    cleanup.push(() => raw.close())
    fake.addresses.set('remote', { host: '127.0.0.1', port: rawAddress.port })
    const client = await clientFor(address, { uploadSlots: 1, transferTimeout: 50 })
    const root = await mkdtemp(path.join(tmpdir(), 'slsk-upload-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const local = path.join(root, 'track.flac')
    await writeFile(local, 'abcd')
    await client.shares.addFile(local, 'Music\\track.flac')
    const remote = await inboundPeer(client)

    const rejected = remote.waitFor((message) => message.code === PeerCode.TransferRequest)
    await remote.send(peer.queueUpload('Music\\track.flac'))
    const rejectedRequest = await rejected
    await remote.send(peer.transferResponse((rejectedRequest.data as { token: number }).token, false, 'no'))
    await new Promise((resolve) => setImmediate(resolve))

    const received: Buffer[] = []
    raw.on('connection', ({ socket }) => {
      void (async () => {
        await readBytes(socket, 4)
        socket.write(new BinaryWriter().uint64(1n).build())
        socket.on('data', (chunk: Buffer) => received.push(chunk))
        socket.resume()
      })()
    })
    const completed = once(client, 'uploadComplete')
    const request = remote.waitFor((message) => message.code === PeerCode.TransferRequest)
    await remote.send(peer.queueUpload('Music\\track.flac'))
    const upload = await request
    await remote.send(peer.transferResponse((upload.data as { token: number }).token, true))
    await completed
    expect(Buffer.concat(received).toString()).toBe('bcd')
    await fake.waitFor(ServerCode.SendUploadSpeed)

    const badRaw = new PeerListener()
    const badAddress = await badRaw.listen(0, '127.0.0.1')
    cleanup.push(() => badRaw.close())
    fake.addresses.set('remote', { host: '127.0.0.1', port: badAddress.port })
    badRaw.on('connection', ({ socket }) => {
      void readBytes(socket, 4).then(() => socket.write(new BinaryWriter().uint64(99n).build()))
    })
    const clientError = once(client, 'clientError')
    const invalid = remote.waitFor((message) => message.code === PeerCode.TransferRequest)
    await remote.send(peer.queueUpload('Music\\track.flac'))
    const invalidRequest = await invalid
    await remote.send(peer.transferResponse((invalidRequest.data as { token: number }).token, true))
    expect((await clientError)[0]).toBeInstanceOf(Error)
  })
})
