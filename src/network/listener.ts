import { EventEmitter } from 'node:events'
import net, { type AddressInfo, type Server, type Socket } from 'node:net'

import {
  decodeFrame,
  FrameDecoder,
  ProtocolError,
  type ProtocolMessage,
} from '../protocol/index.js'
import type { ConnectionOptions } from './connection.js'

export interface IncomingConnection {
  readonly socket: Socket
  readonly initialization: ProtocolMessage
}

async function initialFrame(socket: Socket, maxFrameSize: number, timeout: number): Promise<ProtocolMessage> {
  socket.pause()
  let buffer: Buffer = Buffer.alloc(0)
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Peer did not initialize the connection')), timeout)
    const onData = (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      if (buffer.length < 4) return
      const length = buffer.readUInt32LE(0)
      if (length < 1 || length > maxFrameSize) {
        finish(new ProtocolError(`Invalid peer initialization length: ${length}`))
      } else if (buffer.length >= length + 4) {
        finish(undefined, buffer.subarray(0, length + 4), buffer.subarray(length + 4))
      }
    }
    const onError = (error: Error) => finish(error)
    const onClose = () => finish(new Error('Peer closed before initializing'))
    const finish = (error?: Error, frame?: Buffer, remainder?: Buffer) => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.pause()
      if (remainder && remainder.length > 0) socket.unshift(remainder)
      if (error) reject(error)
      else resolve(frame!)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.resume()
  })
  const frame = new FrameDecoder('peer-init', { maxFrameSize }).push(bytes)[0]
  /* v8 ignore next -- a validated complete frame always produces one decoder result */
  if (!frame) throw new ProtocolError('Missing peer initialization frame')
  return decodeFrame('peer-init', frame)
}

export interface PeerListenerOptions extends ConnectionOptions {
  readonly handshakeTimeout?: number
}

/** Accepts inbound Soulseek connections and reads exactly one initialization frame. */
export class PeerListener extends EventEmitter {
  readonly server: Server
  readonly options: PeerListenerOptions

  constructor(options: PeerListenerOptions = {}) {
    super()
    this.options = options
    this.server = net.createServer((socket) => void this.#accept(socket))
    this.server.on('error', (error) => this.emit('error', error))
  }

  get address(): AddressInfo | null {
    const address = this.server.address()
    return typeof address === 'string' ? null : address
  }

  async #accept(socket: Socket): Promise<void> {
    try {
      const initialization = await initialFrame(
        socket,
        this.options.maxFrameSize ?? 1024 * 1024,
        this.options.handshakeTimeout ?? 10_000,
      )
      if (this.listenerCount('connection') === 0) socket.destroy()
      else this.emit('connection', { socket, initialization } satisfies IncomingConnection)
    } catch (error) {
      socket.destroy()
      this.emit('connectionError', error)
    }
  }

  async listen(port = 0, host = '0.0.0.0'): Promise<AddressInfo> {
    if (this.server.listening) return this.address!
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => finish(error)
      const onListening = () => finish()
      const finish = (error?: Error) => {
        this.server.off('error', onError)
        this.server.off('listening', onListening)
        if (error) reject(error)
        else resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(port, host)
    })
    return this.address!
  }

  async close(): Promise<void> {
    if (!this.server.listening) return
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}
