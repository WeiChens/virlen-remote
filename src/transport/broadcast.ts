/**
 * BroadcastChannel transport —— 同源跨上下文（两个 tab）直连。
 *
 * 用途：M2 的**浏览器联调**。宿主 harness 与手机页放在同一源的两个 tab，
 * 用同名 `BroadcastChannel` 直连 —— **不依赖 WebRTC、不依赖信令服务器**（docs/phone-control-bridge.md §9-M2）。
 *
 * 约束：**仅同源**。生产不可用（生产走 RTC transport，M3）。
 * 同一上下文内创建两个同名实例也能互通（BroadcastChannel 不会回声给发送者自身）。
 */
import type { Transport, TransportState } from './types'

export class BroadcastTransport implements Transport {
  private readonly channel: BroadcastChannel
  private _state: TransportState = 'open'
  private readonly messageListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly stateListeners = new Set<(state: TransportState) => void>()

  constructor(channelName: string) {
    this.channel = new BroadcastChannel(channelName)
    this.channel.onmessage = (event: MessageEvent) => {
      if (this._state !== 'open') return
      const bytes = toBytes(event.data)
      if (!bytes) return
      // 异步投递，模拟真实链路的异步边界（与 memory transport 一致）
      queueMicrotask(() => {
        if (this._state !== 'open') return
        for (const listener of [...this.messageListeners]) listener(bytes)
      })
    }
  }

  get state(): TransportState {
    return this._state
  }

  get bufferedAmount(): number {
    return 0
  }

  send(bytes: Uint8Array): void {
    if (this._state !== 'open') return
    // 结构化克隆：Uint8Array 可跨 tab 直接传递（不复制成普通数组，避免体积膨胀）
    this.channel.postMessage(bytes)
  }

  close(): void {
    if (this._state === 'closed') return
    this._state = 'closed'
    try {
      this.channel.close()
    } catch {
      /* 忽略 */
    }
    for (const listener of [...this.stateListeners]) listener(this._state)
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
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return null
}

/** 建立一对同名 channel 的 transport（同上下文互通用）。 */
export function createBroadcastPair(channelName: string): [BroadcastTransport, BroadcastTransport] {
  return [new BroadcastTransport(channelName), new BroadcastTransport(channelName)]
}
