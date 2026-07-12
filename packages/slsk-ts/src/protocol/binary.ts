import { isIPv4 } from 'node:net'

export class ProtocolError extends Error {
  override readonly name = 'ProtocolError'
}

const MAX_UINT32 = 0xffff_ffff
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn
const utf8Fatal = new TextDecoder('utf-8', { fatal: true })
const latin1 = new TextDecoder('latin1')

function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}`)
  }
}

/** A growable, allocation-conscious writer for Soulseek's little-endian wire types. */
export class BinaryWriter {
  #buffer: Buffer
  #offset = 0

  constructor(initialCapacity = 256) {
    integer(initialCapacity, 1, MAX_UINT32, 'initialCapacity')
    this.#buffer = Buffer.allocUnsafe(initialCapacity)
  }

  get length(): number {
    return this.#offset
  }

  #reserve(bytes: number): void {
    const needed = this.#offset + bytes
    if (!Number.isSafeInteger(needed) || needed > MAX_UINT32) {
      throw new RangeError('message exceeds the Soulseek 32-bit length limit')
    }
    if (needed <= this.#buffer.length) return
    let capacity = this.#buffer.length
    while (capacity < needed) capacity = Math.min(MAX_UINT32, Math.max(capacity * 2, needed))
    const next = Buffer.allocUnsafe(capacity)
    this.#buffer.copy(next, 0, 0, this.#offset)
    this.#buffer = next
  }

  uint8(value: number): this {
    integer(value, 0, 0xff, 'uint8')
    this.#reserve(1)
    this.#buffer.writeUInt8(value, this.#offset)
    this.#offset += 1
    return this
  }

  bool(value: boolean): this {
    return this.uint8(value ? 1 : 0)
  }

  int32(value: number): this {
    integer(value, -0x8000_0000, 0x7fff_ffff, 'int32')
    this.#reserve(4)
    this.#buffer.writeInt32LE(value, this.#offset)
    this.#offset += 4
    return this
  }

  uint32(value: number): this {
    integer(value, 0, MAX_UINT32, 'uint32')
    this.#reserve(4)
    this.#buffer.writeUInt32LE(value, this.#offset)
    this.#offset += 4
    return this
  }

  uint64(value: bigint | number): this {
    const bigint = typeof value === 'bigint' ? value : BigInt(value)
    if (bigint < 0n || bigint > MAX_UINT64) throw new RangeError('uint64 is out of range')
    this.#reserve(8)
    this.#buffer.writeBigUInt64LE(bigint, this.#offset)
    this.#offset += 8
    return this
  }

  raw(value: Uint8Array): this {
    this.#reserve(value.byteLength)
    this.#offset += Buffer.from(value.buffer, value.byteOffset, value.byteLength).copy(
      this.#buffer,
      this.#offset,
    )
    return this
  }

  bytes(value: Uint8Array): this {
    return this.uint32(value.byteLength).raw(value)
  }

  string(value: string): this {
    const length = Buffer.byteLength(value)
    this.uint32(length)
    this.#reserve(length)
    this.#offset += this.#buffer.write(value, this.#offset, length, 'utf8')
    return this
  }

  ipv4(value: string): this {
    if (!isIPv4(value)) throw new ProtocolError(`Invalid IPv4 address: ${value}`)
    const octets = value.split('.').map(Number)
    return this.uint8(octets[3]!).uint8(octets[2]!).uint8(octets[1]!).uint8(octets[0]!)
  }

  build(): Buffer {
    return this.#buffer.subarray(0, this.#offset)
  }
}

/** A bounds-checked, zero-copy reader for Soulseek's wire types. */
export class BinaryReader {
  readonly buffer: Buffer
  #offset = 0

  constructor(value: Uint8Array) {
    this.buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }

  get offset(): number {
    return this.#offset
  }

  get remaining(): number {
    return this.buffer.length - this.#offset
  }

  get done(): boolean {
    return this.remaining === 0
  }

  #need(bytes: number): void {
    if (bytes < 0 || bytes > this.remaining) {
      throw new ProtocolError(`Truncated message: need ${bytes} bytes, have ${this.remaining}`)
    }
  }

  uint8(): number {
    this.#need(1)
    return this.buffer[this.#offset++]!
  }

  bool(): boolean {
    return this.uint8() !== 0
  }

  int32(): number {
    this.#need(4)
    const value = this.buffer.readInt32LE(this.#offset)
    this.#offset += 4
    return value
  }

  uint32(): number {
    this.#need(4)
    const value = this.buffer.readUInt32LE(this.#offset)
    this.#offset += 4
    return value
  }

  uint64(): bigint {
    this.#need(8)
    const value = this.buffer.readBigUInt64LE(this.#offset)
    this.#offset += 8
    return value
  }

  raw(length: number): Buffer {
    integer(length, 0, MAX_UINT32, 'length')
    this.#need(length)
    const value = this.buffer.subarray(this.#offset, this.#offset + length)
    this.#offset += length
    return value
  }

  bytes(): Buffer {
    return this.raw(this.uint32())
  }

  string(): string {
    const value = this.raw(this.uint32())
    try {
      return utf8Fatal.decode(value)
    } catch {
      return latin1.decode(value)
    }
  }

  ipv4(): string {
    const bytes = this.raw(4)
    return `${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`
  }

  skip(length: number): this {
    this.raw(length)
    return this
  }

  rest(): Buffer {
    return this.raw(this.remaining)
  }
}
