import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

import { BinaryWriter } from './binary.js'
import { PeerCode, PeerInitCode, ServerCode } from './codes.js'
import type { Frame } from './frame.js'
import { ConnectionType, type FileAttributes, type SharedFile, type UserStatus } from './types.js'

function message(code: number, writer = new BinaryWriter()): Frame {
  return { code, payload: writer.build() }
}

function stringMessage(code: number, value: string): Frame {
  return message(code, new BinaryWriter().string(value))
}

function uint32Message(code: number, value: number): Frame {
  return message(code, new BinaryWriter().uint32(value))
}

function boolMessage(code: number, value: boolean): Frame {
  return message(code, new BinaryWriter().bool(value))
}

function empty(code: number): Frame {
  return message(code)
}

function stringPair(code: number, first: string, second: string): Frame {
  return message(code, new BinaryWriter().string(first).string(second))
}

function writeAttributes(writer: BinaryWriter, attributes: FileAttributes): void {
  const values: [number, number][] = []
  if (attributes.bitrate !== undefined) values.push([0, attributes.bitrate])
  if (attributes.length !== undefined) values.push([1, attributes.length])
  if (attributes.variableBitrate !== undefined) values.push([2, attributes.variableBitrate ? 1 : 0])
  if (attributes.encoder !== undefined) values.push([3, attributes.encoder])
  if (attributes.sampleRate !== undefined) values.push([4, attributes.sampleRate])
  if (attributes.bitDepth !== undefined) values.push([5, attributes.bitDepth])
  if (attributes.unknown) values.push(...attributes.unknown)
  writer.uint32(values.length)
  for (const [key, value] of values) writer.uint32(key).uint32(value)
}

function writeFile(writer: BinaryWriter, file: SharedFile): void {
  writer.uint8(file.code).string(file.filename).uint64(file.size)
  writer.bytes(file.extension ? Buffer.from(file.extension) : Buffer.alloc(0))
  writeAttributes(writer, file.attributes)
}

function writeFiles(writer: BinaryWriter, files: readonly SharedFile[]): void {
  writer.uint32(files.length)
  for (const file of files) writeFile(writer, file)
}

function compressed(code: number, writer: BinaryWriter): Frame {
  return message(code, new BinaryWriter().raw(deflateSync(writer.build(), { level: 4 })))
}

export const server = {
  raw: message,
  login(username: string, password: string, majorVersion = 177, minorVersion = 1): Frame {
    const digest = createHash('md5').update(username + password).digest('hex')
    return message(
      ServerCode.Login,
      new BinaryWriter()
        .string(username)
        .string(password)
        .uint32(majorVersion)
        .string(digest)
        .uint32(minorVersion),
    )
  },
  setListenPort: (port: number) => uint32Message(ServerCode.SetListenPort, port),
  getPeerAddress: (username: string) => stringMessage(ServerCode.GetPeerAddress, username),
  watchUser: (username: string) => stringMessage(ServerCode.WatchUser, username),
  unwatchUser: (username: string) => stringMessage(ServerCode.UnwatchUser, username),
  getUserStatus: (username: string) => stringMessage(ServerCode.GetUserStatus, username),
  ignoreUser: (username: string) => stringMessage(ServerCode.IgnoreUser, username),
  unignoreUser: (username: string) => stringMessage(ServerCode.UnignoreUser, username),
  sayChatroom: (room: string, text: string) => stringPair(ServerCode.SayChatroom, room, text),
  joinRoom: (room: string, privateRoom = false) =>
    message(ServerCode.JoinRoom, new BinaryWriter().string(room).uint32(privateRoom ? 1 : 0)),
  leaveRoom: (room: string) => stringMessage(ServerCode.LeaveRoom, room),
  connectToPeer: (token: number, username: string, type: ConnectionType) =>
    message(ServerCode.ConnectToPeer, new BinaryWriter().uint32(token).string(username).string(type)),
  messageUser: (username: string, text: string) => stringPair(ServerCode.MessageUser, username, text),
  acknowledgeMessage: (id: number) => uint32Message(ServerCode.MessageAcknowledged, id),
  search: (token: number, query: string) =>
    message(ServerCode.FileSearch, new BinaryWriter().uint32(token).string(query)),
  setStatus: (status: UserStatus) => message(ServerCode.SetStatus, new BinaryWriter().int32(status)),
  ping: () => empty(ServerCode.Ping),
  sharedCounts: (directories: number, files: number) =>
    message(ServerCode.SharedCounts, new BinaryWriter().uint32(directories).uint32(files)),
  getUserStats: (username: string) => stringMessage(ServerCode.GetUserStats, username),
  userSearch: (username: string, token: number, query: string) =>
    message(ServerCode.UserSearch, new BinaryWriter().string(username).uint32(token).string(query)),
  addLike: (item: string) => stringMessage(ServerCode.AddLike, item),
  removeLike: (item: string) => stringMessage(ServerCode.RemoveLike, item),
  recommendations: () => empty(ServerCode.Recommendations),
  globalRecommendations: () => empty(ServerCode.GlobalRecommendations),
  userInterests: (username: string) => stringMessage(ServerCode.UserInterests, username),
  roomList: () => empty(ServerCode.RoomList),
  haveNoParent: (value: boolean) => boolMessage(ServerCode.HaveNoParent, value),
  checkPrivileges: () => empty(ServerCode.CheckPrivileges),
  acceptChildren: (value: boolean) => boolMessage(ServerCode.AcceptChildren, value),
  wishlistSearch: (token: number, query: string) =>
    message(ServerCode.WishlistSearch, new BinaryWriter().uint32(token).string(query)),
  similarUsers: () => empty(ServerCode.SimilarUsers),
  itemRecommendations: (item: string) => stringMessage(ServerCode.ItemRecommendations, item),
  itemSimilarUsers: (item: string) => stringMessage(ServerCode.ItemSimilarUsers, item),
  setRoomTicker: (room: string, text: string) => stringPair(ServerCode.SetRoomTicker, room, text),
  addHate: (item: string) => stringMessage(ServerCode.AddHate, item),
  removeHate: (item: string) => stringMessage(ServerCode.RemoveHate, item),
  roomSearch: (room: string, token: number, query: string) =>
    message(ServerCode.RoomSearch, new BinaryWriter().string(room).uint32(token).string(query)),
  sendUploadSpeed: (bytesPerSecond: number) => uint32Message(ServerCode.SendUploadSpeed, bytesPerSecond),
  givePrivileges: (username: string, days: number) =>
    message(ServerCode.GivePrivileges, new BinaryWriter().string(username).uint32(days)),
  branchLevel: (level: number) => uint32Message(ServerCode.BranchLevel, level),
  branchRoot: (username: string) => stringMessage(ServerCode.BranchRoot, username),
  addRoomMember: (room: string, username: string) => stringPair(ServerCode.AddRoomMember, room, username),
  removeRoomMember: (room: string, username: string) =>
    stringPair(ServerCode.RemoveRoomMember, room, username),
  cancelRoomMembership: (room: string) => stringMessage(ServerCode.CancelRoomMembership, room),
  cancelRoomOwnership: (room: string) => stringMessage(ServerCode.CancelRoomOwnership, room),
  enableRoomInvitations: (enabled: boolean) => boolMessage(ServerCode.EnableRoomInvitations, enabled),
  changePassword: (password: string) => stringMessage(ServerCode.ChangePassword, password),
  addRoomOperator: (room: string, username: string) =>
    stringPair(ServerCode.AddRoomOperator, room, username),
  removeRoomOperator: (room: string, username: string) =>
    stringPair(ServerCode.RemoveRoomOperator, room, username),
  messageUsers: (usernames: readonly string[], text: string) => {
    const writer = new BinaryWriter().uint32(usernames.length)
    for (const username of usernames) writer.string(username)
    return message(ServerCode.MessageUsers, writer.string(text))
  },
  joinGlobalRoom: () => empty(ServerCode.JoinGlobalRoom),
  leaveGlobalRoom: () => empty(ServerCode.LeaveGlobalRoom),
  relatedSearch: (query: string) => stringMessage(ServerCode.RelatedSearch, query),
  cannotConnectToPeer: (token: number, username: string) =>
    message(ServerCode.CannotConnectToPeer, new BinaryWriter().uint32(token).string(username)),
} as const

export const peerInit = {
  pierceFirewall: (token: number) => uint32Message(PeerInitCode.PierceFirewall, token),
  initialize: (username: string, type: ConnectionType) =>
    message(PeerInitCode.PeerInit, new BinaryWriter().string(username).string(type).uint32(0)),
} as const

export interface BrowseFolder {
  readonly directory: string
  readonly files: readonly SharedFile[]
}

export interface SearchResponseInput {
  readonly username: string
  readonly token: number
  readonly files: readonly SharedFile[]
  readonly privateFiles?: readonly SharedFile[]
  readonly freeUploadSlots: boolean
  readonly uploadSpeed: number
  readonly queueLength: number
}

export const peer = {
  raw: message,
  browseRequest: () => empty(PeerCode.BrowseRequest),
  browseResponse(publicFolders: readonly BrowseFolder[], privateFolders: readonly BrowseFolder[] = []): Frame {
    const writer = new BinaryWriter().uint32(publicFolders.length)
    for (const folder of publicFolders) {
      writer.string(folder.directory)
      writeFiles(writer, folder.files)
    }
    writer.uint32(0).uint32(privateFolders.length)
    for (const folder of privateFolders) {
      writer.string(folder.directory)
      writeFiles(writer, folder.files)
    }
    return compressed(PeerCode.BrowseResponse, writer)
  },
  searchRequest: (token: number, query: string) =>
    message(PeerCode.SearchRequest, new BinaryWriter().uint32(token).string(query)),
  searchResponse(input: SearchResponseInput): Frame {
    const writer = new BinaryWriter().string(input.username).uint32(input.token)
    writeFiles(writer, input.files)
    writer.bool(input.freeUploadSlots).uint32(input.uploadSpeed).uint32(input.queueLength).uint32(0)
    if (input.privateFiles) writeFiles(writer, input.privateFiles)
    return compressed(PeerCode.SearchResponse, writer)
  },
  infoRequest: () => empty(PeerCode.InfoRequest),
  infoResponse: (input: {
    description: string
    picture?: Uint8Array
    totalUploads: number
    queueSize: number
    slotsAvailable: boolean
    uploadPermission: number
  }) => {
    const writer = new BinaryWriter().string(input.description).bool(input.picture !== undefined)
    if (input.picture) writer.bytes(input.picture)
    return message(
      PeerCode.InfoResponse,
      writer
        .uint32(input.totalUploads)
        .uint32(input.queueSize)
        .bool(input.slotsAvailable)
        .uint32(input.uploadPermission),
    )
  },
  folderContentsRequest: (token: number, directory: string) =>
    message(PeerCode.FolderContentsRequest, new BinaryWriter().uint32(token).string(directory)),
  folderContentsResponse: (token: number, directory: string, folders: readonly BrowseFolder[]) => {
    const writer = new BinaryWriter().uint32(token).string(directory).uint32(folders.length)
    for (const folder of folders) {
      writer.string(folder.directory)
      writeFiles(writer, folder.files)
    }
    return compressed(PeerCode.FolderContentsResponse, writer)
  },
  transferRequest: (direction: number, token: number, filename: string, size?: bigint) => {
    const writer = new BinaryWriter().uint32(direction).uint32(token).string(filename)
    if (size !== undefined) writer.uint64(size)
    return message(PeerCode.TransferRequest, writer)
  },
  transferResponse: (token: number, allowed: boolean, reasonOrSize?: string | bigint) => {
    const writer = new BinaryWriter().uint32(token).bool(allowed)
    if (typeof reasonOrSize === 'string') writer.string(reasonOrSize)
    else if (reasonOrSize !== undefined) writer.uint64(reasonOrSize)
    return message(PeerCode.TransferResponse, writer)
  },
  queueUpload: (filename: string) => stringMessage(PeerCode.QueueUpload, filename),
  placeInQueueResponse: (filename: string, place: number) =>
    message(PeerCode.PlaceInQueueResponse, new BinaryWriter().string(filename).uint32(place)),
  uploadFailed: (filename: string) => stringMessage(PeerCode.UploadFailed, filename),
  uploadDenied: (filename: string, reason: string) => stringPair(PeerCode.UploadDenied, filename, reason),
  placeInQueueRequest: (filename: string) => stringMessage(PeerCode.PlaceInQueueRequest, filename),
} as const
