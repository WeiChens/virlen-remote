/**
 * 内存 transport —— 两个端点直连（测试 / M2 联调）。
 *
 * 用途（docs/phone-control-bridge.md §7-⑯）：
 * 1. 让协议层全部逻辑（分片/超时/幂等/乱序/重连重放）在 vitest 里可覆盖 —— **WebRTC 无法在 CI 里跑**；
 * 2. M2 用它做「电脑侧 bridge + 手机侧 UI」的端到端联调，**不依赖 WebRTC**；
 * 3. 也是将来「把 RTC 挪到 Rust」时，上层代码的退路。
 */
import type { Transport, TransportState } from './types'

export interface MemoryTransportMetrics {
  sent: number
  received: number
  dropped: number
}

export class MemoryTransport implements Transport {
  private _state: TransportState = 'connecting'

  /** 对端；由 `createMemoryPair()` 建立双向链接。 */
  peer: MemoryTransport | null = null

  private readonly messageListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly stateListeners = new Set<(state: TransportState) => void>()
  private readonly metrics: MemoryTransportMetrics = { sent: 0, received: 0, dropped: 0 }

  /** 随机丢包率 0..1（测试用）。 */
  lossRate = 0
  /** 确定性丢包：>0 时下一次 send 丢弃该帧并自减。 */
  private dropNextOutgoing = 0
  /** 确定性丢包：>0 时下一次投递丢弃该帧并自减。 */
  private dropNextIncoming = 0

  get state(): TransportState {
    return this._state
  }

  get bufferedAmount(): number {
    return 0
  }

  /** 累计统计（测试断言用）。 */
  get stats(): MemoryTransportMetrics {
    return { ...this.metrics }
  }

  send(bytes: Uint8Array): void {
    this.metrics.sent++
    if (this._state !== 'open' || !this.peer) {
      this.metrics.dropped++
      return
    }
    if (this.dropNextOutgoing > 0) {
      this.dropNextOutgoing--
      this.metrics.dropped++
      return
    }
    if (this.lossRate > 0 && Math.random() < this.lossRate) {
      this.metrics.dropped++
      return
    }
    this.peer.deliver(bytes)
  }

  close(): void {
    this.setState('closed')
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

  // ───────────────────────── 测试辅助 ─────────────────────────

  open(): void {
    this.setState('open')
  }

  /** 模拟链路断开（双向，原子：先写两端状态再通知）。 */
  disconnect(): void {
    this.transition('closed')
  }

  /** 模拟链路恢复（双向，原子）。 */
  reconnect(): void {
    this.transition('open')
  }

  /** 让接下来 n 次 send 静默丢弃（验证幂等/重放）。 */
  dropOutgoing(n: number): void {
    this.dropNextOutgoing = n
  }

  /** 让接下来 n 次投递静默丢弃（验证超时/重放）。 */
  dropIncoming(n: number): void {
    this.dropNextIncoming = n
  }

  private deliver(bytes: Uint8Array): void {
    if (this._state !== 'open') {
      this.metrics.dropped++
      return
    }
    if (this.dropNextIncoming > 0) {
      this.dropNextIncoming--
      this.metrics.dropped++
      return
    }
    // 异步投递：模拟真实链路的异步边界；queueMicrotask 保证先进先出（顺序性）
    queueMicrotask(() => {
      if (this._state !== 'open') return
      this.metrics.received++
      for (const listener of this.messageListeners) listener(bytes)
    })
  }

  private transition(state: TransportState): void {
    const changed: MemoryTransport[] = []
    if (this._state !== state) {
      this._state = state
      changed.push(this)
    }
    const peer = this.peer
    if (peer && peer._state !== state) {
      peer._state = state
      changed.push(peer)
    }
    // 关键：**先把两端状态写完，再逐个通知**。
    // 否则「重放」的一侧会在通知回调里立即发送，而对端此刻仍是 closed
    // → 帧被 deliver() 静默丢弃，重放失效（真实链路恢复时同样会踩到）。
    for (const t of changed) t.notifyState()
  }

  private notifyState(): void {
    for (const listener of [...this.stateListeners]) listener(this._state)
  }

  private setState(state: TransportState): void {
    if (this._state === state) return
    this._state = state
    this.notifyState()
  }
}

/** 建立一对互连的 transport（双方初始即 open）。 */
export function createMemoryPair(): [MemoryTransport, MemoryTransport] {
  const a = new MemoryTransport()
  const b = new MemoryTransport()
  a.peer = b
  b.peer = a
  a.open()
  b.open()
  return [a, b]
}
