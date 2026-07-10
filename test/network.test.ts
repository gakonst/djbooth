import { EventEmitter, once } from 'node:events'
import net, { type AddressInfo, type Server, type Socket } from 'node:net'
import { PassThrough, Writable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  connectSocket,
  FramedConnection,
  PeerConnection,
  PeerListener,
  receiveSocketBytes,
  readSocketBytes,
  validateAddress,
  writeSocket,
} from '../src/network/index.js'
import {
  ConnectionType,
  encodeFrame,
  PeerCode,
  peer,
  peerInit,
  ProtocolError,
  type ProtocolMessage,
} from '../src/protocol/index.js'

const servers: Server[] = []
const sockets: Socket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) resolve()
          else server.close(() => resolve())
        }),
    ),
  )
  vi.restoreAllMocks()
})

async function listeningServer(onConnection?: (socket: Socket) => void): Promise<{ server: Server; address: AddressInfo }> {
  const server = net.createServer((socket) => {
    sockets.push(socket)
    onConnection?.(socket)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, address: server.address() as AddressInfo }
}

async function socketPair(): Promise<[Socket, Socket]> {
  let resolveServer!: (socket: Socket) => void
  const serverSocket = new Promise<Socket>((resolve) => {
    resolveServer = resolve
  })
  const { address } = await listeningServer(resolveServer)
  const client = await connectSocket({ host: '127.0.0.1', port: address.port })
  sockets.push(client)
  return [client, await serverSocket]
}

describe('socket utilities', () => {
  it('validates and connects addresses', async () => {
    expect(() => validateAddress({ host: '', port: 1 })).toThrow(TypeError)
    for (const port of [0, 65_536, 1.5]) {
      expect(() => validateAddress({ host: 'x', port })).toThrow(RangeError)
    }
    const { address } = await listeningServer()
    const socket = await connectSocket({ host: '127.0.0.1', port: address.port })
    sockets.push(socket)
    socket.setNoDelay(true)
    expect(socket.readyState).toBe('open')
    const controller = new AbortController()
    controller.abort()
    await expect(connectSocket({ host: '127.0.0.1', port: address.port }, {}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    await expect(connectSocket({ host: '127.0.0.1', port: 1 }, { connectTimeout: 100 })).rejects.toBeInstanceOf(Error)

    const hanging = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() {
        this.destroyed = true
      },
    }) as unknown as Socket
    const create = vi.spyOn(net, 'createConnection').mockReturnValue(hanging)
    await expect(connectSocket({ host: 'example.test', port: 1234 }, { connectTimeout: 2 })).rejects.toThrow('timed out')
    create.mockRestore()

    const aborting = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() {
        this.destroyed = true
      },
    }) as unknown as Socket
    const createAbort = vi.spyOn(net, 'createConnection').mockReturnValue(aborting)
    const afterStart = new AbortController()
    const abortPromise = connectSocket({ host: 'example.test', port: 1234 }, {}, afterStart.signal)
    afterStart.abort()
    await expect(abortPromise).rejects.toMatchObject({ name: 'AbortError' })
    createAbort.mockRestore()
  })

  it('handles write success, backpressure, errors, closure, and closed sockets', async () => {
    const immediate = Object.assign(new EventEmitter(), {
      destroyed: false,
      write: vi.fn(() => true),
    }) as unknown as Socket
    await expect(writeSocket(immediate, Buffer.from('x'))).resolves.toBeUndefined()

    const blocked = Object.assign(new EventEmitter(), {
      destroyed: false,
      write: vi.fn(() => false),
    }) as unknown as Socket
    const draining = writeSocket(blocked, Buffer.from('x'))
    blocked.emit('drain')
    await expect(draining).resolves.toBeUndefined()

    const failing = Object.assign(new EventEmitter(), {
      destroyed: false,
      write: vi.fn(() => false),
    }) as unknown as Socket
    const failed = writeSocket(failing, Buffer.from('x'))
    failing.emit('error', new Error('write failed'))
    await expect(failed).rejects.toThrow('write failed')

    const closing = Object.assign(new EventEmitter(), {
      destroyed: false,
      write: vi.fn(() => false),
    }) as unknown as Socket
    const closed = writeSocket(closing, Buffer.from('x'))
    closing.emit('close')
    await expect(closed).rejects.toThrow('closed before buffered')

    const destroyed = Object.assign(new EventEmitter(), { destroyed: true }) as unknown as Socket
    await expect(writeSocket(destroyed, Buffer.from('x'))).rejects.toThrow('Socket is closed')
  })

  it('reads exact byte counts across chunks and preserves trailing bytes', async () => {
    const makeSocket = () =>
      Object.assign(new EventEmitter(), {
        pause: vi.fn(),
        resume: vi.fn(),
        unshift: vi.fn(),
      }) as unknown as Socket

    const socket = makeSocket()
    const reading = readSocketBytes(socket, 4, 100)
    socket.emit('data', Buffer.from([1, 2]))
    socket.emit('data', Buffer.from([3, 4, 5]))
    await expect(reading).resolves.toEqual(Buffer.from([1, 2, 3, 4]))
    expect(socket.unshift).toHaveBeenCalledWith(Buffer.from([5]))

    const failing = makeSocket()
    const error = readSocketBytes(failing, 1, 100)
    failing.emit('error', new Error('read error'))
    await expect(error).rejects.toThrow('read error')

    const ending = makeSocket()
    const ended = readSocketBytes(ending, 1, 100)
    ending.emit('end')
    await expect(ended).rejects.toThrow('ended before')

    const idle = makeSocket()
    await expect(readSocketBytes(idle, 1, 2)).rejects.toThrow('Timed out')
  })

  it('receives bounded socket streams without waiting for peer closure', async () => {
    const source = new PassThrough() as unknown as Socket
    const chunks: Buffer[] = []
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk)
        setImmediate(callback)
      },
    })
    const received: Buffer[] = []
    const transfer = receiveSocketBytes(source, output, 4n, (chunk) => received.push(chunk))
    source.write(Buffer.from('abcd'))
    await expect(transfer).resolves.toBeUndefined()
    expect(Buffer.concat(chunks).toString()).toBe('abcd')
    expect(Buffer.concat(received).toString()).toBe('abcd')

    const shortSource = new PassThrough() as unknown as Socket
    const short = receiveSocketBytes(shortSource, new PassThrough(), 4n, () => {})
    shortSource.end(Buffer.from('abc'))
    await expect(short).rejects.toThrow('size mismatch')

    const longSource = new PassThrough() as unknown as Socket
    const long = receiveSocketBytes(longSource, new PassThrough(), 3n, () => {})
    longSource.end(Buffer.from('abcd'))
    await expect(long).rejects.toThrow('exceeded declared size')

    const preAborted = new AbortController()
    preAborted.abort()
    await expect(
      receiveSocketBytes(new PassThrough() as unknown as Socket, new PassThrough(), 1n, () => {}, preAborted.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })

    const abortingSource = new PassThrough() as unknown as Socket
    const controller = new AbortController()
    const aborted = receiveSocketBytes(abortingSource, new PassThrough(), 1n, () => {}, controller.signal)
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })

    const errorSource = new PassThrough() as unknown as Socket
    const failingOutput = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('output failed'))
      },
    })
    const failed = receiveSocketBytes(errorSource, failingOutput, 1n, () => {})
    errorSource.end(Buffer.from('x'))
    await expect(failed).rejects.toThrow('output failed')

    const finalErrorSource = new PassThrough() as unknown as Socket
    const finalErrorOutput = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
      final(callback) {
        callback(new Error('final output failed'))
      },
    })
    const finalFailed = receiveSocketBytes(finalErrorSource, finalErrorOutput, 1n, () => {})
    finalErrorSource.end(Buffer.from('x'))
    await expect(finalFailed).rejects.toThrow('final output failed')
  })
})

describe('FramedConnection', () => {
  it('sends, receives, waits, closes, and destroys framed traffic', async () => {
    const [leftSocket, rightSocket] = await socketPair()
    const left = new FramedConnection(leftSocket, 'peer')
    const right = new FramedConnection(rightSocket, 'peer', { maxFrameSize: 1024, maxInflatedSize: 1024, noDelay: false })
    const waited = right.waitFor((message) => message.code === PeerCode.QueueUpload)
    await left.send(peer.infoRequest())
    await new Promise((resolve) => setImmediate(resolve))
    const framePromise = new Promise<unknown[]>((resolve) => {
      const handler = (incoming: { code: number }) => {
        if (incoming.code === PeerCode.QueueUpload) {
          right.off('frame', handler)
          resolve([incoming])
        }
      }
      right.on('frame', handler)
    })
    const messagePromise = new Promise<unknown[]>((resolve) => {
      const handler = (incoming: ProtocolMessage) => {
        if (incoming.code === PeerCode.QueueUpload) {
          right.off('message', handler)
          resolve([incoming])
        }
      }
      right.on('message', handler)
    })
    await left.send(peer.queueUpload('file'))
    expect((await framePromise)[0]).toMatchObject({ code: PeerCode.QueueUpload })
    expect((await messagePromise)[0]).toMatchObject({ data: { filename: 'file' } })
    expect(await waited).toMatchObject({ name: 'QueueUpload' })
    const ended = once(right, 'end')
    left.close()
    await ended
    right.destroy()
  })

  it('supports static connect and wait cancellation, timeout, and closure', async () => {
    const { address } = await listeningServer()
    const connection = await FramedConnection.connect({ host: '127.0.0.1', port: address.port }, 'server')
    sockets.push(connection.socket)
    await expect(connection.waitFor(() => false, { timeout: 2 })).rejects.toThrow('Timed out')
    const already = new AbortController()
    already.abort()
    await expect(connection.waitFor(() => true, { signal: already.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const later = new AbortController()
    const aborted = connection.waitFor(() => false, { signal: later.signal })
    later.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    const closing = connection.waitFor(() => false)
    connection.socket.destroy()
    await expect(closing).rejects.toThrow('Connection closed')
  })

  it('emits protocol errors and closes malformed streams', async () => {
    const [leftSocket, rightSocket] = await socketPair()
    const connection = new FramedConnection(rightSocket, 'server')
    const error = once(connection, 'error')
    leftSocket.write(Buffer.from([3, 0, 0, 0, 0, 0, 0]))
    expect((await error)[0]).toBeInstanceOf(ProtocolError)
    expect(connection.socket.destroyed).toBe(true)
  })

  it('forwards socket errors', async () => {
    const [leftSocket, rightSocket] = await socketPair()
    const connection = new FramedConnection(rightSocket, 'peer')
    const emitted = once(connection, 'error')
    rightSocket.emit('error', new Error('socket failure'))
    await expect(emitted).resolves.toMatchObject([{ message: 'socket failure' }])
    leftSocket.destroy()
  })
})

describe('PeerListener and PeerConnection', () => {
  it('accepts a handshake without consuming a coalesced peer frame', async () => {
    const listener = new PeerListener({ handshakeTimeout: 100, maxFrameSize: 1024 })
    const address = await listener.listen(0, '127.0.0.1')
    expect(await listener.listen()).toEqual(address)
    const incoming = once(listener, 'connection') as Promise<[{
      socket: Socket
      initialization: ProtocolMessage
    }]>
    const socket = await connectSocket({ host: '127.0.0.1', port: address.port })
    sockets.push(socket)
    const init = peerInit.initialize('remote', ConnectionType.Peer)
    socket.setNoDelay(true)
    const queued = peer.queueUpload('file')
    const combined = Buffer.concat([
      encodeFrame('peer-init', init.code, init.payload),
      encodeFrame('peer', queued.code, queued.payload),
    ])
    socket.write(combined.subarray(0, 2))
    await new Promise((resolve) => setTimeout(resolve, 10))
    socket.write(combined.subarray(2, 4))
    await new Promise((resolve) => setTimeout(resolve, 10))
    socket.write(combined.subarray(4))
    const [{ socket: accepted, initialization }] = await incoming
    const connection = PeerConnection.fromIncoming(accepted, initialization)
    expect(connection.username).toBe('remote')
    expect(connection.type).toBe(ConnectionType.Peer)
    expect((await connection.waitFor((message) => message.code === PeerCode.QueueUpload)).data).toEqual({
      filename: 'file',
    })
    connection.destroy()
    await listener.close()
    await listener.close()
  })

  it('opens outgoing peer and distributed connections', async () => {
    const listener = new PeerListener()
    const address = await listener.listen(0, '127.0.0.1')
    const incomingPeer = once(listener, 'connection')
    const peerConnection = await PeerConnection.open(
      { host: '127.0.0.1', port: address.port },
      'local',
      'remote',
      ConnectionType.Peer,
    )
    const [peerIncoming] = (await incomingPeer) as [{ initialization: ProtocolMessage }]
    expect(peerIncoming.initialization.data).toMatchObject({ username: 'local', type: 'P' })
    expect(peerConnection.domain).toBe('peer')
    peerConnection.destroy()

    const incomingDistributed = once(listener, 'connection')
    const distributed = await PeerConnection.open(
      { host: '127.0.0.1', port: address.port },
      'local',
      'remote',
      ConnectionType.Distributed,
    )
    await incomingDistributed
    expect(distributed.domain).toBe('distributed')
    distributed.destroy()
    await listener.close()
  })

  it('rejects invalid and missing initial frames and destroys unhandled connections', async () => {
    const listener = new PeerListener({ handshakeTimeout: 5, maxFrameSize: 5 })
    const address = await listener.listen(0, '127.0.0.1')
    const bad = once(listener, 'connectionError')
    const socket = await connectSocket({ host: '127.0.0.1', port: address.port })
    sockets.push(socket)
    socket.write(Buffer.from([0, 0, 0, 0]))
    await expect(bad).resolves.toBeTruthy()

    const timeout = once(listener, 'connectionError')
    const idle = await connectSocket({ host: '127.0.0.1', port: address.port })
    sockets.push(idle)
    await expect(timeout).resolves.toBeTruthy()
    await listener.close()

    const unhandled = new PeerListener()
    const unhandledAddress = await unhandled.listen(0, '127.0.0.1')
    const raw = await connectSocket({ host: '127.0.0.1', port: unhandledAddress.port })
    sockets.push(raw)
    const init = peerInit.initialize('u', ConnectionType.Peer)
    raw.write(encodeFrame('peer-init', init.code, init.payload))
    await once(raw, 'close')
    await unhandled.close()
  })

  it('handles handshake socket errors and early closure and forwards server errors', async () => {
    const listener = new PeerListener({ handshakeTimeout: 100 })
    const address = await listener.listen(0, '127.0.0.1')
    listener.server.once('connection', (socket) => {
      setImmediate(() => socket.emit('error', new Error('handshake failure')))
    })
    const failed = once(listener, 'connectionError')
    const socket = await connectSocket({ host: '127.0.0.1', port: address.port })
    sockets.push(socket)
    expect((await failed)[0]).toMatchObject({ message: 'handshake failure' })

    const closed = once(listener, 'connectionError')
    const early = await connectSocket({ host: '127.0.0.1', port: address.port })
    early.end()
    expect((await closed)[0]).toBeInstanceOf(Error)

    const serverError = once(listener, 'error')
    listener.server.emit('error', new Error('server failure'))
    expect((await serverError)[0]).toMatchObject({ message: 'server failure' })
    await listener.close()
  })

  it('reports unix addresses, listen failures, and close callback errors', async () => {
    const unix = new PeerListener()
    const socketPath = `/tmp/slsk-listener-${process.pid}-${Date.now()}.sock`
    unix.server.listen(socketPath)
    await once(unix.server, 'listening')
    expect(unix.address).toBeNull()
    await unix.close()

    const occupied = await listeningServer()
    const failing = new PeerListener()
    failing.on('error', () => {})
    await expect(failing.listen(occupied.address.port, '127.0.0.1')).rejects.toBeInstanceOf(Error)

    const closing = new PeerListener()
    await closing.listen(0, '127.0.0.1')
    const originalClose = closing.server.close.bind(closing.server)
    vi.spyOn(closing.server, 'close').mockImplementation((callback) => {
      callback?.(new Error('close failure'))
      return closing.server
    })
    await expect(closing.close()).rejects.toThrow('close failure')
    vi.restoreAllMocks()
    await new Promise<void>((resolve) => originalClose(() => resolve()))
  })
})
