/**
 * RTC transport —— 真实链路（WebRTC DataChannel）。
 *
 * 只依赖两个注入点，因此**可单测**（不需要真实 WebRTC）：
 *   - `signaling`：信令通道（`SignalingChannel`，M3 用 SSE 实现；测试用环回实现）
 *   - `createPeerConnection`：`RTCPeerConnection` 工厂（测试用假实现）
 *
 * 角色（见 §8 拍板）：**电脑(host) 发起 offer**，手机(guest) 应答。
 * 电脑常驻房间，手机加入后由电脑发 offer —— 手机可能在后台切换，桌面是稳定进程。
 *
 * 状态映射：`connected → open`；`failed/closed → closed`；`disconnected → connecting`（等重连）。
 */
import type { Transport, TransportState } from './types'
import type { KickedInfo, SignalingChannel, SignalingRole } from './signaling'
import type { IceServerInit } from './ice'
import { BridgeError, toBridgeError } from '../protocol/errors'

export interface RtcTransportOptions {
  role: SignalingRole
  signaling: SignalingChannel
  /**
   * ICE 服务器列表。**不再有内置默认值**（M7，§31）：两端都由
   * `resolveIceServers()` 决定（自定义 > 服务端下发 > 缓存 > 空）。
   */
  iceServers?: IceServerInit[]
  /** 数据通道 label（对两端须一致）。 */
  channelLabel?: string
  /** 注入 `RTCPeerConnection` 工厂（测试用；默认取全局构造器）。 */
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection
}

type SignalData =
  | { kind: 'offer'; sdp: RTCSessionDescriptionInit }
  | { kind: 'answer'; sdp: RTCSessionDescriptionInit }
  | { kind: 'candidate'; cand: RTCIceCandidateInit | null }

export class RtcTransport implements Transport {
  private _state: TransportState = 'connecting'
  private readonly messageListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly stateListeners = new Set<(state: TransportState) => void>()

  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private started = false
  /** 被顶号（致命）：置位后一切重建/重连动作都无意义。 */
  private replaced = false

  private readonly readyPromise: Promise<void>
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null

  constructor(private readonly options: RtcTransportOptions) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    const sig = options.signaling
    sig.onPeer = (peerId) => this.onPeer(peerId)
    sig.onData = (data) => {
      void this.handleRemote(data)
    }
    sig.onError = (err) => this.fail(err)
    sig.onKicked = (info) => this.onKicked(info)
  }

  get state(): TransportState {
    return this._state
  }

  get bufferedAmount(): number {
    return this.dc?.bufferedAmount ?? 0
  }

  /** 链路真正可用的 Promise（DataChannel open 时 resolve）；失败/关闭时 reject。 */
  whenReady(): Promise<void> {
    return this.readyPromise
  }

  /** 加入信令房间并开始协商。使用方创建后调用一次（不需要 await，靠状态/`whenReady` 驱动）。 */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      await this.options.signaling.join()
    } catch (err) {
      this.fail(toBridgeError(err))
    }
  }

  send(bytes: Uint8Array): void {
    const dc = this.dc
    if (this._state !== 'open' || !dc || dc.readyState !== 'open') return
    // 注：DOM 定义的 `send` 要求 `ArrayBufferView<ArrayBuffer>`，而 `Uint8Array` 泛型是
    // `ArrayBufferLike`（可能含 SharedArrayBuffer）。实际数据永远是普通 buffer，安全 cast。
    dc.send(bytes as unknown as ArrayBufferView<ArrayBuffer>)
  }

  close(): void {
    if (this._state === 'closed') return
    this.teardownPeer()
    try {
      this.options.signaling.close()
    } catch {
      /* 忽略 */
    }
    this.setState('closed')
    this.readyReject?.(new Error('transport closed'))
  }

  onMessage(listener: (bytes: Uint8Array) => void): () => void {
    this.messageListeners.add(listener)
    return () => {
      this.messageListeners.delete(listener)
    }
  }

  onStateChange(listener: (state: TransportState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  // ───────────────────────── 内部：信令 → 协商 ─────────────────────────

  private onPeer(peerId: string | null): void {
    // 被顶号后信令已停用：此时任何对端变化都不该再重建 PC（重建出来也是死链路）
    if (this.replaced) return
    if (peerId === null) {
      // 对端离开：清掉旧连接，回到等待态（手机重连后会重新触发）
      this.teardownPeer()
      this.setState('connecting')
      return
    }
    // 只有 host 主动发起：guest 必须等 offer 到达才建 PC（否则会建两次 PC、上下文串味）
    if (this.options.role === 'host') {
      this.ensurePC()
      void this.startOffer()
    }
  }

  /**
   * 被服务端顶号（同一台电脑已有别的手机接入）。
   *
   * 顺序是刻意的：**先把错误告知上层，再改状态**。上层（手机端 `connectionStore`）在
   * 看到 `closed` 时会安排自动重连 —— 而重连会把刚接入的那台手机再顶掉（乒乓）。
   * 所以「被顶号」这个事实必须先于状态变化到达。
   */
  private onKicked(info: KickedInfo): void {
    if (this.replaced) return
    this.replaced = true
    this.fail(
      new BridgeError('E_REPLACED', '该电脑已被另一台手机接管连接', {
        data: { reason: info.reason },
      }),
    )
    this.teardownPeer()
    try {
      this.options.signaling.close()
    } catch {
      /* 忽略 */
    }
    // 状态置 closed 收尾（`_state` 为 closed 时 `close()` 也不会重复处理）
    this.setState('closed')
  }

  private ensurePC(): RTCPeerConnection {
    if (this.pc) return this.pc
    const factory = this.options.createPeerConnection ?? defaultFactory()
    const pc = factory({ iceServers: this.options.iceServers ?? [] })
    this.pc = pc

    pc.onicecandidate = (e) => {
      if (!e.candidate) return
      void this.options.signaling.send({ kind: 'candidate', cand: candidateToJson(e.candidate) })
    }
    pc.onconnectionstatechange = () => this.onConnectionState(pc.connectionState)
    pc.ondatachannel = (e) => this.setupDataChannel(e.channel)
    return pc
  }

  private async startOffer(): Promise<void> {
    const pc = this.pc
    if (!pc) return
    if (!this.dc) {
      this.setupDataChannel(pc.createDataChannel(this.options.channelLabel ?? 'virlen'))
    }
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await this.options.signaling.send({ kind: 'offer', sdp: pc.localDescription ?? offer })
    } catch (err) {
      this.fail(toBridgeError(err))
    }
  }

  private async handleRemote(data: unknown): Promise<void> {
    const msg = data as SignalData
    if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') return
    try {
      if (msg.kind === 'offer') {
        // 每个 offer 视作新会话：清旧上下文，避免新旧 ICE 串味（同 rtc.js）
        if (this.pc) this.teardownPeer()
        const pc = this.ensurePC()
        await pc.setRemoteDescription(msg.sdp)
        await this.flushCandidates()
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await this.options.signaling.send({ kind: 'answer', sdp: pc.localDescription ?? answer })
      } else if (msg.kind === 'answer') {
        const pc = this.pc
        if (!pc) return
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(msg.sdp)
          await this.flushCandidates()
        }
      } else if (msg.kind === 'candidate') {
        const pc = this.pc
        if (!pc || !msg.cand) return
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(msg.cand).catch(() => {})
        } else {
          this.pendingCandidates.push(msg.cand)
        }
      }
    } catch (err) {
      this.fail(toBridgeError(err))
    }
  }

  private async flushCandidates(): Promise<void> {
    const list = this.pendingCandidates
    this.pendingCandidates = []
    const pc = this.pc
    if (!pc) return
    for (const cand of list) {
      await pc.addIceCandidate(cand).catch(() => {})
    }
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    this.dc = channel
    try {
      channel.binaryType = 'arraybuffer'
    } catch {
      /* 某些实现只读 */
    }
    channel.onopen = () => {
      this.setState('open')
      this.readyResolve?.()
    }
    channel.onclose = () => {
      // 通道关闭：等待对端重连（不永久 closed）
      this.setState('connecting')
    }
    channel.onmessage = (e: MessageEvent) => {
      const bytes = toBytes(e.data)
      if (!bytes) return
      for (const listener of [...this.messageListeners]) listener(bytes)
    }
  }

  private onConnectionState(connState: RTCPeerConnectionState): void {
    switch (connState) {
      case 'connected':
        // ⚠️ **不在这里置 open**：`connectionState` 可能**早于** DataChannel 的 `open` 触发。
        // 尤其 guest（手机）侧：dc 是 `ondatachannel` **异步交付**的，此刻 `this.dc` 可能还是 null
        // → 上层 `whenReady` 已 resolve、`transport.state==='open'`，但 `send()` 因 dc 未就绪而
        // **静默丢弃**（2026-09 真机踩过：手机“连接超时”，电脑端日志 open→4s→connecting）。
        // 统一以 `dc.onopen` 为准 —— 回归用例在 rtc-transport.test.ts。
        break
      case 'failed':
      case 'closed':
        this.setState('closed')
        this.readyReject?.(new Error(`peer connection ${connState}`))
        break
      case 'disconnected':
        this.setState('connecting')
        break
      default:
        break
    }
  }

  private teardownPeer(): void {
    this.pendingCandidates = []
    try {
      this.dc?.close()
    } catch {
      /* 忽略 */
    }
    try {
      this.pc?.close()
    } catch {
      /* 忽略 */
    }
    this.dc = null
    this.pc = null
  }

  private fail(error: Error): void {
    this.readyReject?.(error)
    this.onErrorListeners?.(error)
  }

  private onErrorListeners: ((error: Error) => void) | null = null

  /** 订阅「链路级错误」（区别于状态变化）；返回取消订阅函数。 */
  onError(listener: (error: Error) => void): () => void {
    this.onErrorListeners = listener
    return () => {
      if (this.onErrorListeners === listener) this.onErrorListeners = null
    }
  }

  private setState(state: TransportState): void {
    if (this._state === state) return
    this._state = state
    for (const listener of [...this.stateListeners]) listener(state)
  }
}

function defaultFactory(): (config: RTCConfiguration) => RTCPeerConnection {
  return (config: RTCConfiguration) => {
    const Ctor = (globalThis as { RTCPeerConnection?: new (c: RTCConfiguration) => RTCPeerConnection })
      .RTCPeerConnection
    if (!Ctor) {
      throw new Error('当前环境没有 RTCPeerConnection，未注入 createPeerConnection')
    }
    return new Ctor(config)
  }
}

function candidateToJson(candidate: RTCIceCandidate): RTCIceCandidateInit {
  const withJson = candidate as RTCIceCandidate & { toJSON?: () => RTCIceCandidateInit }
  return typeof withJson.toJSON === 'function' ? withJson.toJSON() : (candidate as unknown as RTCIceCandidateInit)
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return null
}
