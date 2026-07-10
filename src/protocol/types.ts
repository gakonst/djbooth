export enum ConnectionType {
  Peer = 'P',
  File = 'F',
  Distributed = 'D',
}

export enum UserStatus {
  Offline = 0,
  Away = 1,
  Online = 2,
}

export enum TransferDirection {
  Download = 0,
  Upload = 1,
}

export enum FileAttribute {
  Bitrate = 0,
  Length = 1,
  VariableBitrate = 2,
  Encoder = 3,
  SampleRate = 4,
  BitDepth = 5,
}

export interface Address {
  readonly host: string
  readonly port: number
}

export interface FileAttributes {
  readonly bitrate?: number
  readonly length?: number
  readonly variableBitrate?: boolean
  readonly encoder?: number
  readonly sampleRate?: number
  readonly bitDepth?: number
  readonly unknown?: ReadonlyMap<number, number>
}

export interface SharedFile {
  readonly code: number
  readonly filename: string
  readonly size: bigint
  readonly extension?: string
  readonly attributes: FileAttributes
}

export interface SearchResult {
  readonly username: string
  readonly token: number
  readonly files: readonly SharedFile[]
  readonly privateFiles: readonly SharedFile[]
  readonly freeUploadSlots: boolean
  readonly uploadSpeed: number
  readonly queueLength: number
}

export interface UserStats {
  readonly username: string
  readonly averageSpeed: number
  readonly uploadCount: number
  readonly files: number
  readonly directories: number
  readonly unknown: number
}

export interface RoomUser extends UserStats {
  readonly status: UserStatus
  readonly slotsFull: number
  readonly country: string
}

export interface Room {
  readonly name: string
  readonly users: number
}

export interface Recommendation {
  readonly item: string
  readonly score: number
}

export interface ProtocolMessage<T = unknown> {
  readonly domain: import('./codes.js').MessageDomain
  readonly code: number
  readonly name: string
  readonly payload: Buffer
  readonly data: T
}
