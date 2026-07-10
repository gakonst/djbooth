import { EventEmitter, once } from 'node:events'
import net, { type Socket } from 'node:net'
import type { Writable } from 'node:stream'

import {
  decodeFrame,
  encodeFrame,
  FrameDecoder,
  type Address,
  type Frame,
  type MessageDomain,
  type ProtocolMessage,
} from '../protocol/index.js'

export interface ConnectionOptions {
  readonly connectTimeout?: number
  readonly keepAliveInitialDelay?: number
  readonly maxFrameSize?: number
  readonly maxInflatedSize?: number
  readonly noDelay?: boolean
}

export interface WaitOptions {
  readonly timeout?: number
  readonly signal?: AbortSignal
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}

export function validateAddress(address: Address): void {
  if (!address.host) throw new TypeError('host is required')
  if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65_535) {
    throw new RangeError('port must be between 1 and 65535')
  }
}

export async function connectSocket(
  address: Address,
  options: ConnectionOptions = {},
  signal?: AbortSignal,
): Promise<Socket> {
  validateAddress(address)
  if (signal?.aborted) throw abortError()
  const socket = net.createConnection(address)
  const timeout = options.connectTimeout ?? 10_000
  return new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Connection to ${address.host}:${address.port} timed out`)), timeout)
    const onAbort = () => finish(abortError())
    const finish = (error?: Error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.off('connect', onConnect)
      socket.off('error', onError)
      if (error) {
        socket.destroy()
        reject(error)
      } else {
        resolve(socket)
      }
    }
    const onConnect = () => finish()
    const onError = (error: Error) => finish(error)
    socket.once('connect', onConnect)
    socket.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function writeSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  if (socket.destroyed) throw new Error('Socket is closed')
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (socket.write(buffer)) return
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      socket.off('drain', onDrain)
      socket.off('error', onError)
      socket.off('close', onClose)
      if (error) reject(error)
      else resolve()
    }
    const onDrain = () => finish()
    const onError = (error: Error) => finish(error)
    const onClose = () => finish(new Error('Socket closed before buffered data was written'))
    socket.once('drain', onDrain)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/** Reads an exact byte count without consuming any coalesced bytes that follow it. */
export async function readSocketBytes(socket: Socket, length: number, timeout: number): Promise<Buffer> {
  socket.pause()
  let buffer: Buffer = Buffer.alloc(0)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${length} bytes`)), timeout)
    const onData = (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      if (buffer.length >= length) {
        finish(undefined, buffer.subarray(0, length), buffer.subarray(length))
      }
    }
    const onError = (error: Error) => finish(error)
    const onEnd = () => finish(new Error(`Connection ended before ${length} bytes were received`))
    const finish = (error?: Error, result?: Buffer, remainder?: Buffer) => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('end', onEnd)
      socket.pause()
      if (remainder && remainder.length > 0) socket.unshift(remainder)
      if (error) reject(error)
      else resolve(result!)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('end', onEnd)
    socket.resume()
  })
}

/** Copies exactly the declared byte count from a socket and then closes it without waiting for peer FIN. */
export async function receiveSocketBytes(
  socket: Socket,
  output: Writable,
  expected: bigint,
  onChunk: (chunk: Buffer) => void,
  signal?: AbortSignal,
): Promise<void> {
  let received = 0n
  signal?.throwIfAborted()
  const onAbort = () => socket.destroy(abortError())
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const value of socket.iterator({ destroyOnReturn: false })) {
      const chunk = value as Buffer
      const next = received + BigInt(chunk.length)
      if (next > expected) throw new Error(`Download exceeded declared size of ${expected} bytes`)
      received = next
      onChunk(chunk)
      if (!output.write(chunk)) await once(output, 'drain', { signal })
      if (received === expected) break
    }
    if (received !== expected) {
      throw new Error(`Download size mismatch: expected ${expected}, received ${received}`)
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      output.once('error', onError)
      output.end(() => {
        output.off('error', onError)
        resolve()
      })
    })
  } finally {
    signal?.removeEventListener('abort', onAbort)
    socket.destroy()
  }
}

/** A framed Soulseek connection with bounded decoding and backpressure-aware writes. */
export class FramedConnection extends EventEmitter {
  readonly socket: Socket
  readonly domain: MessageDomain
  readonly decoder: FrameDecoder
  readonly maxInflatedSize: number | undefined

  constructor(socket: Socket, domain: MessageDomain, options: ConnectionOptions = {}) {
    super()
    this.socket = socket
    this.domain = domain
    this.decoder =
      options.maxFrameSize === undefined
        ? new FrameDecoder(domain)
        : new FrameDecoder(domain, { maxFrameSize: options.maxFrameSize })
    this.maxInflatedSize = options.maxInflatedSize
    socket.setNoDelay(options.noDelay ?? true)
    socket.setKeepAlive(true, options.keepAliveInitialDelay ?? 30_000)
    socket.on('data', (chunk) => this.#data(chunk))
    socket.on('error', (error) => this.emit('error', error))
    socket.on('close', (hadError) => this.emit('close', hadError))
    socket.on('end', () => this.emit('end'))
    socket.resume()
  }

  static async connect(
    address: Address,
    domain: MessageDomain,
    options: ConnectionOptions = {},
    signal?: AbortSignal,
  ): Promise<FramedConnection> {
    const socket = await connectSocket(address, options, signal)
    return new FramedConnection(socket, domain, options)
  }

  #data(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk)) {
        const message =
          this.maxInflatedSize === undefined
            ? decodeFrame(this.domain, frame)
            : decodeFrame(this.domain, frame, { maxInflatedSize: this.maxInflatedSize })
        this.emit('frame', frame)
        this.emit('message', message)
      }
    } catch (error) {
      this.emit('error', error)
      this.socket.destroy()
    }
  }

  async send(frame: Frame): Promise<void> {
    await writeSocket(this.socket, encodeFrame(this.domain, frame.code, frame.payload))
  }

  waitFor<T extends ProtocolMessage = ProtocolMessage>(
    predicate: (message: ProtocolMessage) => message is T,
    options?: WaitOptions,
  ): Promise<T>
  waitFor(
    predicate: (message: ProtocolMessage) => boolean,
    options?: WaitOptions,
  ): Promise<ProtocolMessage>
  waitFor(
    predicate: (message: ProtocolMessage) => boolean,
    options: WaitOptions = {},
  ): Promise<ProtocolMessage> {
    if (options.signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const timeout = options.timeout ?? 10_000
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${this.domain} message`)), timeout)
      const onAbort = () => finish(abortError())
      const onMessage = (message: ProtocolMessage) => {
        if (predicate(message)) finish(undefined, message)
      }
      const onClose = () => finish(new Error('Connection closed while waiting for a message'))
      const finish = (error?: Error, message?: ProtocolMessage) => {
        clearTimeout(timer)
        this.off('message', onMessage)
        this.off('close', onClose)
        options.signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(message!)
      }
      this.on('message', onMessage)
      this.once('close', onClose)
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  close(): void {
    this.socket.end()
  }

  destroy(error?: Error): void {
    this.socket.destroy(error)
  }
}
