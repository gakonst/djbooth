import type { Socket } from 'node:net'

import {
  encodeFrame,
  peerInit,
  type Address,
  type ConnectionType,
  type ProtocolMessage,
} from '../protocol/index.js'
import { connectSocket, FramedConnection, writeSocket, type ConnectionOptions } from './connection.js'

export class PeerConnection extends FramedConnection {
  readonly username: string
  readonly type: ConnectionType

  constructor(socket: Socket, username: string, type: ConnectionType, options: ConnectionOptions = {}) {
    super(socket, type === 'D' ? 'distributed' : 'peer', options)
    this.username = username
    this.type = type
  }

  static async open(
    address: Address,
    localUsername: string,
    remoteUsername: string,
    type: ConnectionType,
    options: ConnectionOptions = {},
    signal?: AbortSignal,
  ): Promise<PeerConnection> {
    const socket = await connectSocket(address, options, signal)
    const init = peerInit.initialize(localUsername, type)
    await writeSocket(socket, encodeFrame('peer-init', init.code, init.payload))
    return new PeerConnection(socket, remoteUsername, type, options)
  }

  static fromIncoming(
    socket: Socket,
    initialization: ProtocolMessage,
    options: ConnectionOptions = {},
  ): PeerConnection {
    const data = initialization.data as { username: string; type: ConnectionType }
    return new PeerConnection(socket, data.username, data.type, options)
  }
}
