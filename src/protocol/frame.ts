import { BinaryWriter, ProtocolError } from './binary.js'
import { codeWidth, type MessageDomain } from './codes.js'

export interface Frame {
  readonly code: number
  readonly payload: Buffer
}

export function encodeFrame(domain: MessageDomain, code: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const width = codeWidth(domain)
  const writer = new BinaryWriter(8 + payload.byteLength)
  writer.uint32(width + payload.byteLength)
  if (width === 1) writer.uint8(code)
  else writer.uint32(code)
  return writer.raw(payload).build()
}

export interface FrameDecoderOptions {
  readonly maxFrameSize?: number
}

/** Incrementally decodes arbitrary TCP chunk boundaries into protocol frames. */
export class FrameDecoder {
  readonly domain: MessageDomain
  readonly maxFrameSize: number
  #buffer: Buffer = Buffer.alloc(0)
  #offset = 0

  constructor(domain: MessageDomain, options: FrameDecoderOptions = {}) {
    this.domain = domain
    this.maxFrameSize = options.maxFrameSize ?? 128 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxFrameSize) || this.maxFrameSize < codeWidth(domain)) {
      throw new RangeError('maxFrameSize is too small')
    }
  }

  get bufferedBytes(): number {
    return this.#buffer.length - this.#offset
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0)
    this.#offset = 0
  }

  push(chunk: Uint8Array): Frame[] {
    if (chunk.byteLength === 0) return []
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (this.bufferedBytes === 0) {
      this.#buffer = incoming
      this.#offset = 0
    } else {
      this.#buffer = Buffer.concat([this.#buffer.subarray(this.#offset), incoming])
      this.#offset = 0
    }

    const frames: Frame[] = []
    const width = codeWidth(this.domain)
    while (this.bufferedBytes >= 4) {
      const length = this.#buffer.readUInt32LE(this.#offset)
      if (length < width) throw new ProtocolError(`Invalid ${this.domain} frame length: ${length}`)
      if (length > this.maxFrameSize) {
        throw new ProtocolError(`${this.domain} frame exceeds ${this.maxFrameSize} bytes`)
      }
      if (this.bufferedBytes < length + 4) break
      const codeOffset = this.#offset + 4
      const code =
        width === 1 ? this.#buffer.readUInt8(codeOffset) : this.#buffer.readUInt32LE(codeOffset)
      const payload = this.#buffer.subarray(codeOffset + width, codeOffset + length)
      frames.push({ code, payload })
      this.#offset += 4 + length
    }

    if (this.#offset === this.#buffer.length) this.reset()
    return frames
  }
}
