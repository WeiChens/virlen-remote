/**
 * 环回信令 —— 单测用：两个 `SignalingChannel` 直连（不碰网络）。
 */
import type { SignalingChannel } from '../../src/transport/signaling'

export class FakeSignaling implements SignalingChannel {
  selfId: string
  peerId: string | null = null
  onPeer: ((peerId: string | null) => void) | null = null
  onData: ((data: unknown) => void) | null = null
  onError: ((error: Error) => void) | null = null
  onKicked: ((info: { reason: string }) => void) | null = null

  joined = false
  other: FakeSignaling | null = null
  /** 本端发出的信令（断言用）。 */
  sent: unknown[] = []

  constructor(selfId: string) {
    this.selfId = selfId
  }

  /** 测试用：模拟服务端把本端顶掉（新的 guest 加入同一房间）。 */
  kickFromServer(reason = 'replaced'): void {
    if (this.peerId !== null) this.peerId = null
    this.onKicked?.({ reason })
  }

  async join(): Promise<string> {
    this.joined = true
    this.notifyIfBothJoined()
    this.other?.notifyIfBothJoined()
    return this.selfId
  }

  notifyIfBothJoined(): void {
    const other = this.other
    if (!other || !this.joined || !other.joined) return
    if (this.peerId === other.selfId) return
    this.peerId = other.selfId
    this.onPeer?.(this.peerId)
  }

  async send(data: unknown): Promise<void> {
    this.sent.push(data)
    const other = this.other
    if (!other || !this.peerId) return
    queueMicrotask(() => other.onData?.(data))
  }

  close(): void {
    const other = this.other
    if (this.peerId !== null) {
      this.peerId = null
      this.onPeer?.(null)
    }
    if (other && other.peerId !== null) {
      other.peerId = null
      other.onPeer?.(null)
    }
  }
}

export function createLoopbackSignaling(): [FakeSignaling, FakeSignaling] {
  const host = new FakeSignaling('host-1')
  const guest = new FakeSignaling('guest-1')
  host.other = guest
  guest.other = host
  return [host, guest]
}
