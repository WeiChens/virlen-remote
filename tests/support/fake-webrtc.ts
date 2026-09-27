/**
 * 假 WebRTC —— 单测用最小 `RTCPeerConnection` / `RTCDataChannel` 实现。
 *
 * 目的：不依赖真实浏览器 WebRTC（CI 跑不了），仍能验证 `RtcTransport` 的**协商编排**
 * 与**字节通道**。行为对齐真实语义：
 *  - offerer 的 `createDataChannel` 在连接后交付给 answerer 的 `ondatachannel`；
 *  - `signalingState` 随 local/remote description 变化（`have-local-offer` / `have-remote-offer` / `stable`）；
 *  - 双方各持一端 channel，`send` 异步投递到对端 `onmessage`。
 */

export class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting'
  binaryType = 'blob'
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  peer: FakeDataChannel | null = null

  send(data: unknown): void {
    const peer = this.peer
    if (!peer || peer.readyState !== 'open') return
    queueMicrotask(() => peer.onmessage?.({ data }))
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
  }
}

export class FakePeerConnection {
  localDescription: RTCSessionDescription | null = null
  remoteDescription: RTCSessionDescription | null = null
  connectionState: RTCPeerConnectionState = 'new'

  onicecandidate: ((e: { candidate: unknown }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ondatachannel: ((e: { channel: FakeDataChannel }) => void) | null = null

  createdChannels: FakeDataChannel[] = []
  deliveredChannels: FakeDataChannel[] = []

  private hasLocal = false
  private hasRemote = false

  constructor(private readonly net: FakeWebRTCNetwork) {}

  get signalingState(): RTCSignalingState {
    if (this.hasLocal && !this.hasRemote) return 'have-local-offer'
    if (!this.hasLocal && this.hasRemote) return 'have-remote-offer'
    return 'stable'
  }

  createDataChannel(_label?: string, _opts?: unknown): FakeDataChannel {
    const dc = new FakeDataChannel()
    this.createdChannels.push(dc)
    return dc
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'fake-offer' }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'fake-answer' }
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.hasLocal = true
    this.localDescription = desc as RTCSessionDescription
    this.net.maybeConnect()
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.hasRemote = true
    this.remoteDescription = desc as RTCSessionDescription
    this.net.maybeConnect()
  }

  async addIceCandidate(_c?: unknown): Promise<void> {
    /* 假实现：候选不影响连接 */
  }

  async getStats(): Promise<Map<string, unknown>> {
    return new Map()
  }

  close(): void {
    if (this.connectionState === 'closed') return
    this.connectionState = 'closed'
    this.onconnectionstatechange?.()
  }
}

export interface FakeWebRTCNetworkOptions {
  /** 见 `FakeWebRTCNetwork.connectOrder`。 */
  connectOrder?: 'channel-first' | 'connection-first'
  /** 为 `false` 时不自动打开数据通道，由测试调用 `openChannels()` 手动推进。 */
  autoOpenChannels?: boolean
}

export class FakeWebRTCNetwork {
  readonly pcs: FakePeerConnection[] = []

  /**
   * `connectionState='connected'` 与 DataChannel `onopen` 的触发顺序。
   *
   * 默认 **`'connection-first'`** —— 真实浏览器里**更危险的那个顺序**：
   * `connectionState` 先变 `connected`，DataChannel 稍后才 `open`（guest 侧尤其如此，
   * 它的 dc 是 `ondatachannel` **异步交付**的）。
   *
   * `RtcTransport` 因此**只认 `dc.onopen`**；若哪天退回「见 connected 就置 open」，
   * 会表现为「以为通了就发」→ 帧被 `send` 静默丢弃（真机踩过，见 rtc-transport.test.ts 的回归用例）。
   * 把危险顺序设为默认，可让**全部用例**都在该顺序下运行，防止回归。
   */
  readonly connectOrder: 'channel-first' | 'connection-first'

  /** 为 `false` 时数据通道保持 `connecting`，由测试显式调用 `openChannels()`。 */
  readonly autoOpenChannels: boolean

  private connected = false
  private channelsOpened = false
  private readonly channels: Array<{ offerer: FakeDataChannel; answerer: FakeDataChannel }> = []
  private markConnected: (() => void) | null = null

  constructor(options: FakeWebRTCNetworkOptions = {}) {
    this.connectOrder = options.connectOrder ?? 'connection-first'
    this.autoOpenChannels = options.autoOpenChannels ?? true
  }

  /** 传给 `RtcTransport` 的工厂。 */
  readonly factory = (_config?: RTCConfiguration): RTCPeerConnection => {
    const pc = new FakePeerConnection(this)
    this.pcs.push(pc)
    return pc as unknown as RTCPeerConnection
  }

  maybeConnect(): void {
    if (this.connected) return
    const [a, b] = this.pcs
    if (!a || !b) return
    if (!a.localDescription || !a.remoteDescription) return
    if (!b.localDescription || !b.remoteDescription) return
    this.connected = true

    // offerer = 建了 data channel 的一侧；把它的 channel 交付给 answerer
    const offerer = a.createdChannels.length > 0 ? a : b.createdChannels.length > 0 ? b : null
    const answerer = offerer === a ? b : a
    if (offerer) {
      const offererDc = offerer.createdChannels[0]
      const answererDc = new FakeDataChannel()
      offererDc.peer = answererDc
      answererDc.peer = offererDc
      answerer.deliveredChannels.push(answererDc)
      // 交付时 dc 仍是 `connecting`（与真实语义一致）
      answerer.ondatachannel?.({ channel: answererDc })
      this.channels.push({ offerer: offererDc, answerer: answererDc })
    }

    this.markConnected = () => {
      a.connectionState = 'connected'
      b.connectionState = 'connected'
      a.onconnectionstatechange?.()
      b.onconnectionstatechange?.()
    }
    if (this.connectOrder === 'connection-first') this.flushMarkConnected()
    if (this.autoOpenChannels) this.openChannels()
  }

  /** 打开全部数据通道（`autoOpenChannels: false` 时由测试手动推进）。 */
  openChannels(): void {
    if (this.channelsOpened) return
    this.channelsOpened = true
    for (const { offerer, answerer } of this.channels) {
      offerer.readyState = 'open'
      answerer.readyState = 'open'
      offerer.onopen?.()
      answerer.onopen?.()
    }
    // channel-first：通道先开，连接状态随后
    this.flushMarkConnected()
  }

  private flushMarkConnected(): void {
    const fn = this.markConnected
    this.markConnected = null
    fn?.()
  }
}
