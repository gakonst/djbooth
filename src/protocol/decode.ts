import { inflateSync } from 'node:zlib'

import { BinaryReader, ProtocolError } from './binary.js'
import {
  DistributedCode,
  PeerCode,
  PeerInitCode,
  ServerCode,
  type MessageDomain,
} from './codes.js'
import type { Frame } from './frame.js'
import {
  FileAttribute,
  UserStatus,
  type FileAttributes,
  type ProtocolMessage,
  type Recommendation,
  type Room,
  type RoomUser,
  type SharedFile,
} from './types.js'

export interface DecodeOptions {
  readonly maxInflatedSize?: number
}

const DEFAULT_MAX_INFLATED_SIZE = 256 * 1024 * 1024

function nameFor(domain: MessageDomain, code: number): string {
  const table =
    domain === 'server'
      ? ServerCode
      : domain === 'peer-init'
        ? PeerInitCode
        : domain === 'peer'
          ? PeerCode
          : DistributedCode
  return (table[code] as string | undefined) ?? `Unknown(${code})`
}

function list<T>(reader: BinaryReader, read: () => T): T[] {
  const count = reader.uint32()
  return Array.from({ length: count }, () => read())
}

function strings(reader: BinaryReader): string[] {
  return list(reader, () => reader.string())
}

function fileAttributes(reader: BinaryReader): FileAttributes {
  const values = new Map<number, number>()
  const count = reader.uint32()
  for (let index = 0; index < count; index++) values.set(reader.uint32(), reader.uint32())
  const known = new Set<number>(Object.values(FileAttribute).filter((value) => typeof value === 'number'))
  const unknown = new Map([...values].filter(([key]) => !known.has(key)))
  return {
    ...(values.has(FileAttribute.Bitrate) ? { bitrate: values.get(FileAttribute.Bitrate)! } : {}),
    ...(values.has(FileAttribute.Length) ? { length: values.get(FileAttribute.Length)! } : {}),
    ...(values.has(FileAttribute.VariableBitrate)
      ? { variableBitrate: values.get(FileAttribute.VariableBitrate) !== 0 }
      : {}),
    ...(values.has(FileAttribute.Encoder) ? { encoder: values.get(FileAttribute.Encoder)! } : {}),
    ...(values.has(FileAttribute.SampleRate)
      ? { sampleRate: values.get(FileAttribute.SampleRate)! }
      : {}),
    ...(values.has(FileAttribute.BitDepth) ? { bitDepth: values.get(FileAttribute.BitDepth)! } : {}),
    ...(unknown.size > 0 ? { unknown } : {}),
  }
}

function fileSize(reader: BinaryReader): bigint {
  if (reader.remaining < 8) throw new ProtocolError('Truncated file size')
  if (reader.buffer[reader.offset + 7] === 0xff) {
    const value = BigInt(reader.uint32())
    reader.skip(4)
    return value
  }
  return reader.uint64()
}

function sharedFile(reader: BinaryReader): SharedFile {
  const code = reader.uint8()
  const filename = reader.string().replaceAll('/', '\\')
  const size = fileSize(reader)
  const extensionBytes = reader.raw(reader.uint32())
  return {
    code,
    filename,
    size,
    ...(extensionBytes.length > 0 ? { extension: extensionBytes.toString('utf8') } : {}),
    attributes: fileAttributes(reader),
  }
}

function files(reader: BinaryReader): SharedFile[] {
  return list(reader, () => sharedFile(reader))
}

function recommendations(reader: BinaryReader): {
  recommendations: Recommendation[]
  unrecommendations: Recommendation[]
} {
  const all = list(reader, () => ({ item: reader.string(), score: reader.int32() }))
  return {
    recommendations: all.filter(({ score }) => score >= 0),
    unrecommendations: all.filter(({ score }) => score < 0),
  }
}

function roomUsers(reader: BinaryReader): RoomUser[] {
  const names = strings(reader)
  type MutableRoomUser = { -readonly [Key in keyof RoomUser]?: RoomUser[Key] }
  const users = names.map((username) => ({ username }) as MutableRoomUser)
  for (let index = 0, count = reader.uint32(); index < count; index++) {
    users[index]!.status = reader.uint32() as UserStatus
  }
  for (let index = 0, count = reader.uint32(); index < count; index++) {
    Object.assign(users[index]!, {
      averageSpeed: reader.uint32(),
      uploadCount: reader.uint32(),
      unknown: reader.uint32(),
      files: reader.uint32(),
      directories: reader.uint32(),
    })
  }
  for (let index = 0, count = reader.uint32(); index < count; index++) {
    users[index]!.slotsFull = reader.uint32()
  }
  for (let index = 0, count = reader.uint32(); index < count; index++) {
    users[index]!.country = reader.string()
  }
  return users as RoomUser[]
}

function rooms(reader: BinaryReader, withCounts = true): Room[] | string[] {
  const names = strings(reader)
  if (!withCounts) return names
  const counts = list(reader, () => reader.uint32())
  return names.map((name, index) => ({ name, users: counts[index] ?? 0 }))
}

function inflate(payload: Buffer, maxInflatedSize: number): BinaryReader {
  try {
    return new BinaryReader(inflateSync(payload, { maxOutputLength: maxInflatedSize }))
  } catch (error) {
    throw new ProtocolError(`Invalid or oversized compressed message: ${(error as Error).message}`)
  }
}

function decodeServer(code: number, reader: BinaryReader): unknown {
  switch (code) {
    case ServerCode.Login: {
      const success = reader.bool()
      const message = reader.string()
      if (!success) return { success, rejectionReason: message, ...(reader.done ? {} : { detail: reader.string() }) }
      return {
        success,
        banner: message,
        ip: reader.ipv4(),
        checksum: reader.string(),
        supporter: reader.bool(),
      }
    }
    case ServerCode.GetPeerAddress:
      return {
        username: reader.string(),
        ip: reader.ipv4(),
        port: reader.uint32(),
        ...(reader.done
          ? {}
          : { obfuscationType: reader.uint32(), obfuscatedPort: reader.remaining >= 4 ? reader.uint32() : reader.uint8() }),
      }
    case ServerCode.WatchUser: {
      const username = reader.string()
      const exists = reader.bool()
      if (!exists) return { username, exists }
      return {
        username,
        exists,
        status: reader.uint32() as UserStatus,
        averageSpeed: reader.uint32(),
        uploadCount: reader.uint32(),
        unknown: reader.uint32(),
        files: reader.uint32(),
        directories: reader.uint32(),
        ...(reader.done ? {} : { country: reader.string() }),
      }
    }
    case ServerCode.GetUserStatus:
      return { username: reader.string(), status: reader.uint32() as UserStatus, privileged: reader.bool() }
    case ServerCode.IgnoreUser:
    case ServerCode.UnignoreUser:
    case ServerCode.LeaveRoom:
    case ServerCode.RoomAdded:
    case ServerCode.RoomRemoved:
    case ServerCode.AddToPrivileged:
    case ServerCode.RoomSomething:
    case ServerCode.RoomMembershipGranted:
    case ServerCode.RoomMembershipRevoked:
    case ServerCode.RoomOperatorshipGranted:
    case ServerCode.RoomOperatorshipRevoked:
    case ServerCode.ChangePassword:
    case ServerCode.CannotCreateRoom:
      return { value: reader.string() }
    case ServerCode.SayChatroom:
    case ServerCode.GlobalRoomMessage:
      return { room: reader.string(), username: reader.string(), message: reader.string() }
    case ServerCode.JoinRoom: {
      const room = reader.string()
      const users = roomUsers(reader)
      if (reader.done) return { room, users, private: false }
      return { room, users, private: true, owner: reader.string(), operators: strings(reader) }
    }
    case ServerCode.UserJoinedRoom:
      return {
        room: reader.string(),
        user: {
          username: reader.string(),
          status: reader.uint32() as UserStatus,
          averageSpeed: reader.uint32(),
          uploadCount: reader.uint32(),
          unknown: reader.uint32(),
          files: reader.uint32(),
          directories: reader.uint32(),
          slotsFull: reader.uint32(),
          country: reader.string(),
        },
      }
    case ServerCode.UserLeftRoom:
      return { room: reader.string(), username: reader.string() }
    case ServerCode.ConnectToPeer:
      return {
        username: reader.string(),
        type: reader.string(),
        ip: reader.ipv4(),
        port: reader.uint32(),
        token: reader.uint32(),
        privileged: reader.bool(),
        ...(reader.done
          ? {}
          : { obfuscationType: reader.uint32(), obfuscatedPort: reader.uint32() }),
      }
    case ServerCode.MessageUser:
      return {
        id: reader.uint32(),
        timestamp: reader.uint32(),
        username: reader.string(),
        message: reader.string(),
        new: reader.bool(),
      }
    case ServerCode.FileSearch:
      return { username: reader.string(), token: reader.uint32(), query: reader.string() }
    case ServerCode.GetUserStats:
      return {
        username: reader.string(),
        averageSpeed: reader.uint32(),
        uploadCount: reader.uint32(),
        unknown: reader.uint32(),
        files: reader.uint32(),
        directories: reader.uint32(),
      }
    case ServerCode.UploadSlotsFull:
      return { username: reader.string(), slotsFull: reader.uint32() }
    case ServerCode.Relogged:
    case ServerCode.Ping:
    case ServerCode.ResetDistributed:
      return {}
    case ServerCode.SimilarRecommendations:
      return { item: reader.string(), similar: strings(reader) }
    case ServerCode.Recommendations:
    case ServerCode.GlobalRecommendations:
      return recommendations(reader)
    case ServerCode.MyRecommendations:
      return { items: strings(reader) }
    case ServerCode.UserInterests:
      return { username: reader.string(), likes: strings(reader), hates: strings(reader) }
    case ServerCode.PlaceInLineRequest:
      return { username: reader.string(), token: reader.uint32() }
    case ServerCode.PlaceInLineResponse:
      return { username: reader.string(), token: reader.uint32(), place: reader.uint32() }
    case ServerCode.RoomList:
      return {
        rooms: rooms(reader),
        owned: rooms(reader),
        member: rooms(reader),
        operated: rooms(reader, false),
      }
    case ServerCode.AdminMessage:
      return { message: reader.string() }
    case ServerCode.GlobalUserList:
      return { users: roomUsers(reader) }
    case ServerCode.PrivilegedUsers:
      return { users: strings(reader) }
    case ServerCode.ParentMinSpeed:
    case ServerCode.ParentSpeedRatio:
    case ServerCode.ParentInactivityTimeout:
    case ServerCode.SearchInactivityTimeout:
    case ServerCode.MinParentsInCache:
    case ServerCode.DistributedPingInterval:
    case ServerCode.CheckPrivileges:
    case ServerCode.WishlistInterval:
      return { value: reader.uint32() }
    case ServerCode.EmbeddedMessage:
      return { code: reader.uint8(), payload: reader.rest() }
    case ServerCode.PossibleParents:
      return {
        parents: list(reader, () => ({ username: reader.string(), ip: reader.ipv4(), port: reader.uint32() })),
      }
    case ServerCode.SimilarUsers:
      return { users: list(reader, () => ({ username: reader.string(), rating: reader.uint32() })) }
    case ServerCode.ItemRecommendations:
      return { item: reader.string(), ...recommendations(reader) }
    case ServerCode.ItemSimilarUsers:
      return { item: reader.string(), users: strings(reader) }
    case ServerCode.RoomTickers:
      return {
        room: reader.string(),
        tickers: list(reader, () => ({ username: reader.string(), message: reader.string() })),
      }
    case ServerCode.RoomTickerAdded:
      return { room: reader.string(), username: reader.string(), message: reader.string() }
    case ServerCode.RoomTickerRemoved:
      return { room: reader.string(), username: reader.string() }
    case ServerCode.UserPrivileged:
      return { username: reader.string(), privileged: reader.bool() }
    case ServerCode.NotifyPrivileges:
      return { token: reader.uint32(), username: reader.string() }
    case ServerCode.AcknowledgeNotifyPrivileges:
      return { token: reader.uint32() }
    case ServerCode.RoomMembers:
      return { room: reader.string(), users: strings(reader) }
    case ServerCode.AddRoomMember:
    case ServerCode.RemoveRoomMember:
    case ServerCode.AddRoomOperator:
    case ServerCode.RemoveRoomOperator:
      return { room: reader.string(), username: reader.string() }
    case ServerCode.EnableRoomInvitations:
      return { enabled: reader.bool() }
    case ServerCode.RoomOperators:
      return { room: reader.string(), users: strings(reader) }
    case ServerCode.RelatedSearch:
      return {
        query: reader.string(),
        terms: list(reader, () => ({ term: reader.string(), score: reader.uint32() })),
      }
    case ServerCode.ExcludedSearchPhrases:
      return { phrases: strings(reader) }
    case ServerCode.CannotConnectToPeer:
      return { token: reader.uint32(), ...(reader.done ? {} : { username: reader.string() }) }
    default:
      return reader.rest()
  }
}

function decodePeer(code: number, reader: BinaryReader, maxInflatedSize: number): unknown {
  switch (code) {
    case PeerCode.BrowseRequest:
    case PeerCode.InfoRequest:
    case PeerCode.UploadQueueNotification:
      return {}
    case PeerCode.BrowseResponse: {
      const inflated = inflate(reader.rest(), maxInflatedSize)
      const readFolders = () =>
        list(inflated, () => ({ directory: inflated.string(), files: files(inflated) }))
      const publicFolders = readFolders()
      const unknown = inflated.done ? 0 : inflated.uint32()
      const privateFolders = inflated.done ? [] : readFolders()
      return { publicFolders, privateFolders, unknown }
    }
    case PeerCode.SearchRequest:
      return { token: reader.uint32(), query: reader.string() }
    case PeerCode.SearchResponse: {
      const inflated = inflate(reader.rest(), maxInflatedSize)
      const username = inflated.string()
      const token = inflated.uint32()
      const publicFiles = files(inflated)
      const freeUploadSlots = inflated.bool()
      const uploadSpeed = inflated.uint32()
      const queueLength = inflated.uint32()
      const unknown = inflated.done ? 0 : inflated.uint32()
      const privateFiles = inflated.done ? [] : files(inflated)
      return { username, token, publicFiles, privateFiles, freeUploadSlots, uploadSpeed, queueLength, unknown }
    }
    case PeerCode.InfoResponse: {
      const description = reader.string()
      const hasPicture = reader.bool()
      const picture = hasPicture ? reader.bytes() : undefined
      return {
        description,
        hasPicture,
        ...(picture ? { picture } : {}),
        totalUploads: reader.uint32(),
        queueSize: reader.uint32(),
        slotsAvailable: reader.bool(),
        ...(reader.remaining >= 4 ? { uploadPermission: reader.uint32() } : {}),
      }
    }
    case PeerCode.FolderContentsRequest:
      return { token: reader.uint32(), directory: reader.string() }
    case PeerCode.FolderContentsResponse: {
      const inflated = inflate(reader.rest(), maxInflatedSize)
      return {
        token: inflated.uint32(),
        directory: inflated.string(),
        folders: list(inflated, () => ({ directory: inflated.string(), files: files(inflated) })),
      }
    }
    case PeerCode.TransferRequest: {
      const direction = reader.uint32()
      return {
        direction,
        token: reader.uint32(),
        filename: reader.string(),
        ...(direction === 1 ? { size: reader.uint64() } : {}),
      }
    }
    case PeerCode.TransferResponse: {
      const token = reader.uint32()
      const allowed = reader.bool()
      return {
        token,
        allowed,
        ...(reader.done ? {} : allowed ? { size: reader.uint64() } : { reason: reader.string() }),
      }
    }
    case PeerCode.UploadPlaceholder:
    case PeerCode.QueueUpload:
    case PeerCode.UploadFailed:
    case PeerCode.PlaceInQueueRequest:
      return { filename: reader.string() }
    case PeerCode.PlaceInQueueResponse:
      return { filename: reader.string(), place: reader.uint32() }
    case PeerCode.UploadDenied:
      return { filename: reader.string(), reason: reader.string() }
    default:
      return reader.rest()
  }
}

function decodeInit(code: number, reader: BinaryReader): unknown {
  if (code === PeerInitCode.PierceFirewall) return { token: reader.uint32() }
  if (code === PeerInitCode.PeerInit) {
    return {
      username: reader.string(),
      type: reader.string(),
      ...(reader.done ? {} : { token: reader.uint32() }),
    }
  }
  return reader.rest()
}

function decodeDistributed(code: number, reader: BinaryReader): unknown {
  switch (code) {
    case DistributedCode.Ping:
      return {}
    case DistributedCode.Search:
      return { identifier: reader.uint32(), username: reader.string(), token: reader.uint32(), query: reader.string() }
    case DistributedCode.BranchLevel:
      return { level: reader.int32() }
    case DistributedCode.BranchRoot:
      return { username: reader.string() }
    case DistributedCode.ChildDepth:
      return { depth: reader.uint32() }
    case DistributedCode.EmbeddedMessage:
      if (reader.remaining >= 4 && reader.buffer.subarray(reader.offset, reader.offset + 3).equals(Buffer.alloc(3))) {
        reader.skip(3)
      }
      return { code: reader.uint8(), payload: reader.rest() }
    default:
      return reader.rest()
  }
}

export function decodeFrame(
  domain: MessageDomain,
  frame: Frame,
  options: DecodeOptions = {},
): ProtocolMessage {
  const reader = new BinaryReader(frame.payload)
  const maxInflatedSize = options.maxInflatedSize ?? DEFAULT_MAX_INFLATED_SIZE
  if (!Number.isSafeInteger(maxInflatedSize) || maxInflatedSize < 1) {
    throw new RangeError('maxInflatedSize must be a positive safe integer')
  }
  const data =
    domain === 'server'
      ? decodeServer(frame.code, reader)
      : domain === 'peer'
        ? decodePeer(frame.code, reader, maxInflatedSize)
        : domain === 'peer-init'
          ? decodeInit(frame.code, reader)
          : decodeDistributed(frame.code, reader)
  return { domain, code: frame.code, name: nameFor(domain, frame.code), payload: frame.payload, data }
}
