import { randomInt } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import type { Socket } from 'node:net'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import {
  BinaryReader,
  BinaryWriter,
  ConnectionType,
  decodeFrame,
  DistributedCode,
  encodeFrame,
  PeerCode,
  PeerInitCode,
  peer,
  peerInit,
  server,
  ServerCode,
  TransferDirection,
  UserStatus,
  type Address,
  type BrowseFolder,
  type Frame,
  type ProtocolMessage,
  type SearchResult,
  type SharedFile,
} from './protocol/index.js'
import {
  connectSocket,
  FramedConnection,
  PeerConnection,
  PeerListener,
  receiveSocketBytes,
  readSocketBytes,
  writeSocket,
  type ConnectionOptions,
  type IncomingConnection,
} from './network/index.js'
import { ShareIndex, type LocalShare } from './shares.js'

const DEFAULT_SERVER: Address = { host: 'server.slsknet.org', port: 2242 }
const MAX_TOKEN = 0xffff_ffff

export type ClientState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting'

export interface SoulseekClientOptions {
  readonly server?: Address
  readonly listenHost?: string
  readonly listenPort?: number
  readonly connection?: ConnectionOptions
  readonly requestTimeout?: number
  readonly searchTimeout?: number
  readonly transferTimeout?: number
  readonly autoAcknowledge?: boolean
  readonly description?: string
  readonly picture?: Uint8Array
  readonly uploadSlots?: number
  readonly maxSearchResults?: number
  readonly initialToken?: number
}

export interface ConnectOptions {
  readonly signal?: AbortSignal
  readonly majorVersion?: number
  readonly minorVersion?: number
}

export interface SearchOptions {
  readonly timeout?: number
  readonly maxResults?: number
  readonly room?: string
  readonly signal?: AbortSignal
  readonly user?: string
}

export interface DownloadOptions {
  readonly onProgress?: (progress: DownloadProgress) => void
  readonly resume?: boolean
  readonly signal?: AbortSignal
  readonly temporaryPath?: string
  readonly timeout?: number
}

export interface DownloadProgress {
  readonly received: bigint
  readonly size: bigint
  readonly percent: number
}

export interface DownloadResult {
  readonly path: string
  readonly received: bigint
  readonly resumedFrom: bigint
  readonly size: bigint
  readonly username: string
}

export interface BrowseResult {
  readonly publicFolders: readonly BrowseFolder[]
  readonly privateFolders: readonly BrowseFolder[]
}

export class LoginError extends Error {
  override readonly name = 'LoginError'
  readonly reason: string

  constructor(reason: string) {
    super(`Soulseek login failed: ${reason}`)
    this.reason = reason
  }
}

interface SearchCollector {
  readonly results: SearchResult[]
  readonly maxResults: number
  readonly finish: (error?: Error) => void
}

interface IndirectRequest {
  readonly username: string
  readonly type: ConnectionType
  readonly resolve: (socket: Socket) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

interface RawFileRequest {
  readonly username: string
  readonly resolve: (socket: Socket) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

interface QueuedUpload {
  readonly peer: PeerConnection
  readonly share: LocalShare
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}

/** High-level Soulseek client with low-level protocol escape hatches. */
export class SoulseekClient extends EventEmitter {
  readonly options: Required<
    Pick<
      SoulseekClientOptions,
      | 'listenHost'
      | 'listenPort'
      | 'requestTimeout'
      | 'searchTimeout'
      | 'transferTimeout'
      | 'autoAcknowledge'
      | 'description'
      | 'uploadSlots'
      | 'maxSearchResults'
    >
  > &
    SoulseekClientOptions
  readonly shares = new ShareIndex()
  readonly listener: PeerListener
  readonly peers = new Map<string, PeerConnection>()
  readonly distributedPeers = new Set<PeerConnection>()

  state: ClientState = 'disconnected'
  username: string | undefined
  serverConnection: FramedConnection | undefined
  excludedSearchPhrases: readonly string[] = []

  #token: number
  #searches = new Map<number, SearchCollector>()
  #indirect = new Map<number, IndirectRequest>()
  #rawFiles = new Map<number, RawFileRequest>()
  #fileSockets = new Set<Socket>()
  #uploadQueue: QueuedUpload[] = []
  #activeUploads = 0
  #distributedParent: PeerConnection | undefined

  constructor(options: SoulseekClientOptions = {}) {
    super()
    this.options = {
      ...options,
      server: options.server ?? DEFAULT_SERVER,
      listenHost: options.listenHost ?? '0.0.0.0',
      listenPort: options.listenPort ?? 0,
      requestTimeout: options.requestTimeout ?? 10_000,
      searchTimeout: options.searchTimeout ?? 8_000,
      transferTimeout: options.transferTimeout ?? 120_000,
      autoAcknowledge: options.autoAcknowledge ?? true,
      description: options.description ?? 'slsk-ts',
      uploadSlots: options.uploadSlots ?? 2,
      maxSearchResults: options.maxSearchResults ?? 100,
    }
    if (!Number.isInteger(this.options.uploadSlots) || this.options.uploadSlots < 0) {
      throw new RangeError('uploadSlots cannot be negative')
    }
    this.#token = options.initialToken ?? randomInt(1, MAX_TOKEN)
    this.listener = new PeerListener(this.options.connection)
    this.listener.on('connection', (incoming: IncomingConnection) => void this.#incoming(incoming))
    this.listener.on('connectionError', (error) => this.emit('clientError', error))
    this.listener.on('error', (error) => this.emit('clientError', error))
  }

  #nextToken(): number {
    this.#token = this.#token >= MAX_TOKEN ? 1 : this.#token + 1
    return this.#token
  }

  #setState(state: ClientState): void {
    this.state = state
    this.emit('state', state)
  }

  #assertConnected(): FramedConnection {
    if (this.state !== 'connected' || !this.serverConnection) throw new Error('Client is not connected')
    return this.serverConnection
  }

  async connect(username: string, password: string, options: ConnectOptions = {}): Promise<void> {
    if (this.state !== 'disconnected') throw new Error(`Cannot connect while ${this.state}`)
    if (!username || !password) throw new TypeError('username and password are required')
    this.#setState('connecting')
    this.username = username
    try {
      const listening = await this.listener.listen(this.options.listenPort, this.options.listenHost)
      const connection = await FramedConnection.connect(
        this.options.server!,
        'server',
        this.options.connection,
        options.signal,
      )
      this.serverConnection = connection
      connection.on('message', (message: ProtocolMessage) => this.#dispatch(this.#serverMessage(message)))
      connection.on('error', (error) => this.emit('clientError', error))
      connection.on('close', () => {
        if (this.state === 'connected') this.#setState('disconnected')
      })
      const response = connection.waitFor((message) => message.code === ServerCode.Login, {
        timeout: this.options.requestTimeout,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      await connection.send(
        server.login(username, password, options.majorVersion ?? 177, options.minorVersion ?? 1),
      )
      const login = (await response).data as { success: boolean; rejectionReason?: string }
      if (!login.success) throw new LoginError(login.rejectionReason!)
      await connection.send(server.setListenPort(listening.port))
      await connection.send(server.sharedCounts(this.shares.directoryCount, this.shares.fileCount))
      await connection.send(server.setStatus(UserStatus.Online))
      await connection.send(server.haveNoParent(true))
      await connection.send(server.acceptChildren(this.options.uploadSlots > 0))
      this.#setState('connected')
    } catch (error) {
      await this.#cleanup()
      this.#setState('disconnected')
      throw error
    }
  }

  async #cleanup(): Promise<void> {
    for (const peerConnection of this.peers.values()) peerConnection.destroy()
    this.peers.clear()
    for (const peerConnection of this.distributedPeers) peerConnection.destroy()
    this.distributedPeers.clear()
    this.#distributedParent = undefined
    for (const socket of this.#fileSockets) socket.destroy()
    this.#fileSockets.clear()
    this.serverConnection?.destroy()
    this.serverConnection = undefined
    for (const request of this.#indirect.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Client disconnected'))
    }
    this.#indirect.clear()
    for (const request of this.#rawFiles.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Client disconnected'))
    }
    this.#rawFiles.clear()
    for (const search of this.#searches.values()) search.finish(new Error('Client disconnected'))
    this.#searches.clear()
    await this.listener.close()
  }

  async disconnect(): Promise<void> {
    if (this.state === 'disconnected') return
    this.#setState('disconnecting')
    await this.#cleanup()
    this.username = undefined
    this.#setState('disconnected')
  }

  async send(frame: Frame): Promise<void> {
    await this.#assertConnected().send(frame)
  }

  #dispatch(task: Promise<void>): void {
    void task.catch((error) => this.emit('clientError', error))
  }

  async #serverMessage(message: ProtocolMessage): Promise<void> {
    this.emit('message', message)
    this.emit('serverMessage', message)
    if (message.code === ServerCode.MessageUser) {
      const data = message.data as { id: number; username: string; message: string }
      this.emit('privateMessage', data)
      if (this.options.autoAcknowledge) await this.serverConnection!.send(server.acknowledgeMessage(data.id))
    } else if (message.code === ServerCode.SayChatroom || message.code === ServerCode.GlobalRoomMessage) {
      this.emit('roomMessage', message.data)
    } else if (message.code === ServerCode.ConnectToPeer) {
      await this.#connectToRequester(message.data as {
        username: string
        type: ConnectionType
        ip: string
        port: number
        token: number
      })
    } else if (message.code === ServerCode.FileSearch) {
      const data = message.data as { username: string; token: number; query: string }
      await this.#respondToSearch(data.username, data.token, data.query)
    } else if (message.code === ServerCode.ExcludedSearchPhrases) {
      this.excludedSearchPhrases = (message.data as { phrases: string[] }).phrases
    } else if (message.code === ServerCode.EmbeddedMessage) {
      const embedded = message.data as { code: number; payload: Buffer }
      if (embedded.code === DistributedCode.Search) {
        const decoded = decodeFrame('distributed', { code: embedded.code, payload: embedded.payload })
        await this.#distributedMessage(undefined, decoded)
      }
    } else if (message.code === ServerCode.PossibleParents) {
      const { parents } = message.data as { parents: Array<{ username: string; ip: string; port: number }> }
      await this.#adoptDistributedParent(parents)
    } else if (message.code === ServerCode.ResetDistributed) {
      for (const peerConnection of this.distributedPeers) peerConnection.destroy()
      this.distributedPeers.clear()
      this.#distributedParent = undefined
      await this.serverConnection!.send(server.haveNoParent(true))
    }
  }

  async #connectToRequester(request: {
    username: string
    type: ConnectionType
    ip: string
    port: number
    token: number
  }): Promise<void> {
    try {
      const socket = await connectSocket(
        { host: request.ip, port: request.port },
        this.options.connection,
      )
      const init = peerInit.pierceFirewall(request.token)
      await writeSocket(socket, encodeFrame('peer-init', init.code, init.payload))
      if (request.type === ConnectionType.File) void this.#fileSocket(socket, request.username)
      else this.#registerPeer(new PeerConnection(socket, request.username, request.type, this.options.connection))
    } catch (error) {
      await this.serverConnection?.send(server.cannotConnectToPeer(request.token, request.username))
      this.emit('clientError', error)
    }
  }

  async #incoming(incoming: IncomingConnection): Promise<void> {
    const { initialization, socket } = incoming
    if (initialization.code === PeerInitCode.PierceFirewall) {
      const token = (initialization.data as { token: number }).token
      const request = this.#indirect.get(token)
      if (!request) {
        socket.destroy()
        return
      }
      clearTimeout(request.timer)
      this.#indirect.delete(token)
      request.resolve(socket)
      return
    }
    if (initialization.code !== PeerInitCode.PeerInit) {
      socket.destroy()
      return
    }
    const data = initialization.data as { username: string; type: ConnectionType }
    if (data.type === ConnectionType.File) await this.#fileSocket(socket, data.username)
    else this.#registerPeer(PeerConnection.fromIncoming(socket, initialization, this.options.connection))
  }

  #registerPeer(connection: PeerConnection): PeerConnection {
    if (connection.type === ConnectionType.Distributed) {
      this.distributedPeers.add(connection)
      connection.on('message', (message: ProtocolMessage) => this.#dispatch(this.#peerMessage(connection, message)))
      connection.on('error', (error) => this.emit('clientError', error))
      connection.on('close', () => {
        this.distributedPeers.delete(connection)
        if (this.#distributedParent === connection) this.#distributedParent = undefined
      })
      this.emit('peerConnected', connection)
      return connection
    }
    const existing = this.peers.get(connection.username)
    if (existing && !existing.socket.destroyed) {
      connection.destroy()
      return existing
    }
    this.peers.set(connection.username, connection)
    connection.on('message', (message: ProtocolMessage) => this.#dispatch(this.#peerMessage(connection, message)))
    connection.on('error', (error) => this.emit('clientError', error))
    connection.on('close', () => {
      if (this.peers.get(connection.username) === connection) this.peers.delete(connection.username)
    })
    this.emit('peerConnected', connection)
    return connection
  }

  async #peerMessage(connection: PeerConnection, message: ProtocolMessage): Promise<void> {
    this.emit('message', message)
    this.emit('peerMessage', message, connection)
    if (connection.domain === 'distributed') {
      await this.#distributedMessage(connection, message)
    } else if (message.code === PeerCode.SearchResponse) {
      const data = message.data as {
        username: string
        token: number
        publicFiles: SharedFile[]
        privateFiles: SharedFile[]
        freeUploadSlots: boolean
        uploadSpeed: number
        queueLength: number
      }
      const collector = this.#searches.get(data.token)
      if (collector) {
        const result: SearchResult = {
          username: data.username,
          token: data.token,
          files: data.publicFiles,
          privateFiles: data.privateFiles,
          freeUploadSlots: data.freeUploadSlots,
          uploadSpeed: data.uploadSpeed,
          queueLength: data.queueLength,
        }
        collector.results.push(result)
        this.emit('searchResult', result)
        if (collector.results.length >= collector.maxResults) collector.finish()
      }
    } else if (message.code === PeerCode.BrowseRequest) {
      await connection.send(peer.browseResponse(this.shares.browse()))
    } else if (message.code === PeerCode.InfoRequest) {
      await connection.send(
        peer.infoResponse({
          description: this.options.description,
          ...(this.options.picture ? { picture: this.options.picture } : {}),
          totalUploads: 0,
          queueSize: this.#uploadQueue.length,
          slotsAvailable: this.#activeUploads < this.options.uploadSlots,
          uploadPermission: 0,
        }),
      )
    } else if (message.code === PeerCode.FolderContentsRequest) {
      const data = message.data as { token: number; directory: string }
      await connection.send(
        peer.folderContentsResponse(data.token, data.directory, this.shares.folder(data.directory)),
      )
    } else if (message.code === PeerCode.SearchRequest) {
      const data = message.data as { token: number; query: string }
      await this.#sendSearchResponse(connection, data.token, data.query)
    } else if (message.code === PeerCode.QueueUpload) {
      await this.#queueUpload(connection, (message.data as { filename: string }).filename)
    } else if (message.code === PeerCode.PlaceInQueueRequest) {
      const filename = (message.data as { filename: string }).filename
      const place = this.#uploadQueue.findIndex(
        (item) => item.peer.username === connection.username && item.share.filename === filename,
      )
      await connection.send(peer.placeInQueueResponse(filename, place < 0 ? 0 : place + 1))
    } else if (message.code === PeerCode.TransferRequest) {
      const data = message.data as { direction: number; filename: string }
      if (data.direction === TransferDirection.Download) {
        const request = message.data as { token: number }
        await connection.send(peer.transferResponse(request.token, false, 'Queued'))
        await this.#queueUpload(connection, data.filename)
      }
    }
  }

  async #distributedMessage(source: PeerConnection | undefined, message: ProtocolMessage): Promise<void> {
    if (message.code === DistributedCode.Search) {
      const data = message.data as { username: string; token: number; query: string }
      await this.#respondToSearch(data.username, data.token, data.query)
      await Promise.all(
        [...this.distributedPeers]
          .filter((connection) => connection !== source)
          .map((connection) => connection.send({ code: message.code, payload: message.payload })),
      )
    } else if (source === this.#distributedParent && message.code === DistributedCode.BranchLevel) {
      const level = (message.data as { level: number }).level + 1
      await this.serverConnection!.send(server.branchLevel(level))
      await this.serverConnection!.send(server.haveNoParent(false))
    } else if (source === this.#distributedParent && message.code === DistributedCode.BranchRoot) {
      await this.serverConnection!.send(server.branchRoot((message.data as { username: string }).username))
    }
  }

  async #adoptDistributedParent(
    parents: readonly { username: string; ip: string; port: number }[],
  ): Promise<void> {
    if (this.#distributedParent && !this.#distributedParent.socket.destroyed) return
    for (const parent of parents) {
      try {
        const socket = await connectSocket(
          { host: parent.ip, port: parent.port },
          this.options.connection,
        )
        const init = peerInit.initialize(this.username!, ConnectionType.Distributed)
        await writeSocket(socket, encodeFrame('peer-init', init.code, init.payload))
        this.#distributedParent = this.#registerPeer(
          new PeerConnection(socket, parent.username, ConnectionType.Distributed, this.options.connection),
        )
        return
      } catch (error) {
        this.emit('clientError', error)
      }
    }
  }

  async #sendSearchResponse(connection: PeerConnection, token: number, query: string): Promise<void> {
    const files = this.shares.search(query, {
      excludedPhrases: this.excludedSearchPhrases,
      limit: this.options.maxSearchResults,
    })
    if (files.length === 0) return
    await connection.send(
      peer.searchResponse({
        username: this.username!,
        token,
        files,
        freeUploadSlots: this.#activeUploads < this.options.uploadSlots,
        uploadSpeed: 0,
        queueLength: this.#uploadQueue.length,
      }),
    )
  }

  async #respondToSearch(username: string, token: number, query: string): Promise<void> {
    const files = this.shares.search(query, {
      excludedPhrases: this.excludedSearchPhrases,
      limit: this.options.maxSearchResults,
    })
    if (files.length === 0 || username === this.username) return
    try {
      const connection = await this.openPeer(username)
      await connection.send(
        peer.searchResponse({
          username: this.username!,
          token,
          files,
          freeUploadSlots: this.#activeUploads < this.options.uploadSlots,
          uploadSpeed: 0,
          queueLength: this.#uploadQueue.length,
        }),
      )
    } catch (error) {
      this.emit('clientError', error)
    }
  }

  async getPeerAddress(username: string, signal?: AbortSignal): Promise<Address> {
    const connection = this.#assertConnected()
    const response = connection.waitFor(
      (message) =>
        message.code === ServerCode.GetPeerAddress &&
        (message.data as { username?: string }).username === username,
      { timeout: this.options.requestTimeout, ...(signal ? { signal } : {}) },
    )
    await connection.send(server.getPeerAddress(username))
    const data = (await response).data as { ip: string; port: number }
    if (data.port === 0) throw new Error(`${username} is offline or not accepting connections`)
    return { host: data.ip, port: data.port }
  }

  async #indirectSocket(username: string, type: ConnectionType, signal?: AbortSignal): Promise<Socket> {
    const connection = this.#assertConnected()
    const token = this.#nextToken()
    if (signal?.aborted) throw abortError()
    let pending!: IndirectRequest
    const promise = new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#indirect.delete(token)
        reject(new Error(`Indirect connection to ${username} timed out`))
      }, this.options.requestTimeout)
      pending = { username, type, resolve, reject, timer }
      this.#indirect.set(token, pending)
    })
    const onAbort = () => {
      clearTimeout(pending.timer)
      this.#indirect.delete(token)
      pending.reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await connection.send(server.connectToPeer(token, username, type))
      return await promise
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async #openSocket(username: string, type: ConnectionType, signal?: AbortSignal): Promise<Socket> {
    try {
      const address = await this.getPeerAddress(username, signal)
      const socket = await connectSocket(address, this.options.connection, signal)
      const init = peerInit.initialize(this.username!, type)
      await writeSocket(socket, encodeFrame('peer-init', init.code, init.payload))
      return socket
    } catch {
      return this.#indirectSocket(username, type, signal)
    }
  }

  async openPeer(username: string, signal?: AbortSignal): Promise<PeerConnection> {
    this.#assertConnected()
    const existing = this.peers.get(username)
    if (existing && !existing.socket.destroyed) return existing
    const socket = await this.#openSocket(username, ConnectionType.Peer, signal)
    return this.#registerPeer(
      new PeerConnection(socket, username, ConnectionType.Peer, this.options.connection),
    )
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const connection = this.#assertConnected()
    if (!query.trim()) throw new TypeError('search query cannot be empty')
    if (options.user && options.room) throw new TypeError('user and room search scopes are mutually exclusive')
    if (options.signal?.aborted) throw abortError()
    const token = this.#nextToken()
    const results: SearchResult[] = []
    const timeout = options.timeout ?? this.options.searchTimeout
    const maxResults = options.maxResults ?? Number.POSITIVE_INFINITY
    let timer: NodeJS.Timeout
    let onAbort: (() => void) | undefined
    const finished = new Promise<SearchResult[]>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort!)
        this.#searches.delete(token)
        if (error) reject(error)
        else resolve(results)
      }
      timer = setTimeout(() => finish(), timeout)
      onAbort = () => finish(abortError())
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.#searches.set(token, { results, maxResults, finish })
    })
    if (options.user) await connection.send(server.userSearch(options.user, token, query))
    else if (options.room) await connection.send(server.roomSearch(options.room, token, query))
    else await connection.send(server.search(token, query))
    return finished
  }

  async browse(username: string, signal?: AbortSignal): Promise<BrowseResult> {
    const connection = await this.openPeer(username, signal)
    const response = connection.waitFor((message) => message.code === PeerCode.BrowseResponse, {
      timeout: this.options.requestTimeout,
      ...(signal ? { signal } : {}),
    })
    await connection.send(peer.browseRequest())
    return (await response).data as BrowseResult
  }

  async userInfo(username: string, signal?: AbortSignal): Promise<unknown> {
    const connection = await this.openPeer(username, signal)
    const response = connection.waitFor((message) => message.code === PeerCode.InfoResponse, {
      timeout: this.options.requestTimeout,
      ...(signal ? { signal } : {}),
    })
    await connection.send(peer.infoRequest())
    return (await response).data
  }

  async joinRoom(room: string, privateRoom = false): Promise<unknown> {
    const connection = this.#assertConnected()
    const response = connection.waitFor(
      (message) =>
        message.code === ServerCode.JoinRoom && (message.data as { room?: string }).room === room,
      { timeout: this.options.requestTimeout },
    )
    await connection.send(server.joinRoom(room, privateRoom))
    return (await response).data
  }

  async leaveRoom(room: string): Promise<void> {
    await this.send(server.leaveRoom(room))
  }

  async sendPrivateMessage(username: string, text: string): Promise<void> {
    await this.send(server.messageUser(username, text))
  }

  async sendRoomMessage(room: string, text: string): Promise<void> {
    await this.send(server.sayChatroom(room, text))
  }

  async #fileSocket(socket: Socket, username: string): Promise<void> {
    this.#fileSockets.add(socket)
    socket.once('close', () => this.#fileSockets.delete(socket))
    try {
      const token = new BinaryReader(await readSocketBytes(socket, 4, this.options.transferTimeout)).uint32()
      const request = this.#rawFiles.get(token)
      if (!request || request.username !== username) {
        socket.destroy()
        return
      }
      clearTimeout(request.timer)
      this.#rawFiles.delete(token)
      request.resolve(socket)
    } catch (error) {
      socket.destroy()
      this.emit('clientError', error)
    }
  }

  #waitForRawFile(username: string, token: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#rawFiles.delete(token)
        reject(new Error(`File connection from ${username} timed out`))
      }, this.options.transferTimeout)
      this.#rawFiles.set(token, { username, resolve, reject, timer })
    })
  }

  async download(
    username: string,
    filename: string,
    destination: string,
    options: DownloadOptions = {},
  ): Promise<DownloadResult> {
    const connection = await this.openPeer(username, options.signal)
    const timeout = options.timeout ?? this.options.transferTimeout
    const response = connection.waitFor(
      (message) => {
        if (message.code === PeerCode.UploadDenied) {
          return (message.data as { filename?: string }).filename === filename
        }
        return (
          message.code === PeerCode.TransferRequest &&
          (message.data as { direction?: number; filename?: string }).direction === TransferDirection.Upload &&
          (message.data as { filename?: string }).filename === filename
        )
      },
      { timeout, ...(options.signal ? { signal: options.signal } : {}) },
    )
    await connection.send(peer.queueUpload(filename))
    const transfer = await response
    if (transfer.code === PeerCode.UploadDenied) {
      throw new Error((transfer.data as { reason: string }).reason)
    }
    const data = transfer.data as { token: number; size: bigint }
    const raw = this.#waitForRawFile(username, data.token)
    await connection.send(peer.transferResponse(data.token, true))
    const socket = await raw
    const temporaryPath = options.temporaryPath ?? `${destination}.part`
    await mkdir(path.dirname(destination), { recursive: true })
    let resumedFrom = 0n
    if (options.resume ?? true) {
      try {
        resumedFrom = BigInt((await stat(temporaryPath)).size)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    } else {
      await rm(temporaryPath, { force: true })
    }
    if (resumedFrom > data.size) {
      await rm(temporaryPath, { force: true })
      resumedFrom = 0n
    }
    await writeSocket(socket, new BinaryWriter().uint64(resumedFrom).build())
    const output = createWriteStream(temporaryPath, { flags: resumedFrom > 0n ? 'a' : 'w' })
    let received = resumedFrom
    const onData = (chunk: Buffer) => {
      received += BigInt(chunk.length)
      const progress: DownloadProgress = {
        received,
        size: data.size,
        percent: Number((received * 10_000n) / data.size) / 100,
      }
      options.onProgress?.(progress)
      this.emit('downloadProgress', progress, username, filename)
    }
    socket.resume()
    await receiveSocketBytes(socket, output, data.size - resumedFrom, onData, options.signal)
    await rename(temporaryPath, destination)
    const result = { path: destination, username, size: data.size, received, resumedFrom }
    this.emit('downloadComplete', result)
    return result
  }

  async #queueUpload(connection: PeerConnection, filename: string): Promise<void> {
    const share = this.shares.get(filename)
    if (!share) {
      await connection.send(peer.uploadDenied(filename, 'File not shared.'))
      return
    }
    if (
      this.#uploadQueue.some(
        (item) => item.peer.username === connection.username && item.share.filename === filename,
      )
    ) {
      return
    }
    this.#uploadQueue.push({ peer: connection, share })
    this.#pumpUploads()
  }

  #pumpUploads(): void {
    while (this.#activeUploads < this.options.uploadSlots) {
      const item = this.#uploadQueue.shift()
      if (!item) return
      this.#activeUploads += 1
      void this.#upload(item).catch((error) => this.emit('clientError', error)).finally(() => {
        this.#activeUploads -= 1
        this.#pumpUploads()
      })
    }
  }

  async #upload(item: QueuedUpload): Promise<void> {
    const token = this.#nextToken()
    const response = item.peer.waitFor(
      (message) =>
        message.code === PeerCode.TransferResponse &&
        (message.data as { token?: number }).token === token,
      { timeout: this.options.transferTimeout },
    )
    await item.peer.send(
      peer.transferRequest(TransferDirection.Upload, token, item.share.filename, item.share.size),
    )
    const transfer = (await response).data as { allowed: boolean }
    if (!transfer.allowed) return
    const socket = await this.#openSocket(item.peer.username, ConnectionType.File)
    this.#fileSockets.add(socket)
    socket.once('close', () => this.#fileSockets.delete(socket))
    await writeSocket(socket, new BinaryWriter().uint32(token).build())
    const offset = new BinaryReader(
      await readSocketBytes(socket, 8, this.options.transferTimeout),
    ).uint64()
    if (offset > item.share.size) throw new Error('Peer requested an invalid file offset')
    const started = performance.now()
    await pipeline(this.shares.open(item.share.filename, Number(offset)), socket, { end: false })
    socket.end()
    const elapsed = Math.max(1, performance.now() - started)
    const speed = Math.min(MAX_TOKEN, Math.round((Number(item.share.size - offset) * 1000) / elapsed))
    await this.serverConnection?.send(server.sendUploadSpeed(speed))
    this.emit('uploadComplete', { username: item.peer.username, filename: item.share.filename, size: item.share.size })
  }
}
