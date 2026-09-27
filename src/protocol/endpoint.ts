/**
 * Endpoint —— 协议层核心：把「四类接口」统一为 **2 个原语 × 2 个方向**
 * （docs/phone-control-bridge.md §2.1）。
 *
 * ```
 * handle(method, fn)      我实现的、供对方调用      ← 请求接口
 * subscribe(topic, fn)    我订阅的、对方发来的事件  ← 事件接口
 * call(method, params)    我发起的调用              ← 服务接口
 * emit(topic, payload)    我发出的事件              ← 事件接口
 * ```
 * 四类接口是本形状的特例；各写一个模块会得到 4 份重复的序列化/超时/重连代码，且行为必然漂移。
 *
 * 内置可靠性（§3.2）：
 * - **分片**：载荷 > 12KB 自动分片，接收侧按 msgId 归组，不完整则整体丢弃；
 * - **幂等**：收到的 CALL 按 `requestId` 去重（LRU + TTL），命中则**回上次结果而非重放**；
 * - **重连重放**：链路恢复时，未决的 CALL 用**同一 requestId** 重发 → 对端去重，避免重复执行；
 * - **超时分层**：链路非 open → 立即 `E_TRANSPORT`；协议层默认 10s（可随 hello 协商调整）。
 */
import { BridgeError, toBridgeError, type WireError } from './errors'
import { DEFAULT_MAX_FRAME_PAYLOAD, FrameKind, Reassembler, encodeFrames, PROTOCOL_VERSION } from './frame'
import { newRequestId } from './ids'
import type { Transport, TransportState } from '../transport/types'

// ───────────────────────────── 线上载荷 ─────────────────────────────

interface WireCall {
  requestId: string
  method: string
  params: unknown
}

/**
 * RESULT 载荷。
 *
 * 刻意用**扁平可选字段**而非「判别式联合（`{ok:true,data}` | `{ok:false,error}`）」：
 * 消费端 `virlen-app` 的 tsconfig 有 `strictNullChecks: false`，布尔字面量判别式**不会触发联合收窄**，
 * 而共享包以源码形式被消费端直接类型检查 → 判别式联合会在消费端报错（包内自检却通过）。
 * 扁平信封在两种设置下都合法。
 */
interface WireResult {
  requestId: string
  ok: boolean
  /** ok=true 时的结果。 */
  data?: unknown
  /** ok=false 时的错误。 */
  error?: WireError
}

interface WireEvent {
  topic: string
  payload: unknown
}

interface WireCtrl {
  subtype: 'ping' | 'pong' | 'bye' | 'flow'
  [key: string]: unknown
}

// ───────────────────────────── 对外类型 ─────────────────────────────

export interface CallContext {
  readonly requestId: string
  readonly method: string
  readonly origin: 'remote'
}

export interface EventContext {
  readonly topic: string
  readonly origin: 'remote'
}

export type RpcHandler = (params: unknown, ctx: CallContext) => unknown | Promise<unknown>
export type EventSubscriber = (payload: unknown, ctx: EventContext) => void

export interface CallOptions {
  timeoutMs?: number
}

export interface EndpointOptions {
  transport: Transport
  /** 协议层默认超时；可随 hello 协商调整（§3.2）。 <=0 表示不超时。 */
  defaultTimeoutMs?: number
  maxFramePayload?: number
  /** 幂等去重表容量（LRU）。 */
  dedupeSize?: number
  /** 幂等去重表存活时间。 */
  dedupeTtlMs?: number
}

interface PendingCall {
  requestId: string
  method: string
  frames: Uint8Array[]
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

interface DedupeEntry {
  result: WireResult
  at: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_DEDUPE_SIZE = 200
const DEFAULT_DEDUPE_TTL_MS = 5 * 60_000

export class Endpoint {
  private readonly transport: Transport
  private readonly defaultTimeoutMs: number
  private readonly maxFramePayload: number
  private readonly dedupeSize: number
  private readonly dedupeTtlMs: number

  private readonly handlers = new Map<string, RpcHandler>()
  private readonly subscribers = new Map<string, Set<EventSubscriber>>()
  private readonly pending = new Map<string, PendingCall>()
  /** requestId → 上次结果（插入序即 LRU 淘汰序）。 */
  private readonly dedupe = new Map<string, DedupeEntry>()
  private readonly reassembler = new Reassembler()
  private readonly detachers: Array<() => void> = []

  private msgId = 0
  private lastState: TransportState
  private disposed = false

  constructor(options: EndpointOptions) {
    this.transport = options.transport
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxFramePayload = options.maxFramePayload ?? DEFAULT_MAX_FRAME_PAYLOAD
    this.dedupeSize = options.dedupeSize ?? DEFAULT_DEDUPE_SIZE
    this.dedupeTtlMs = options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS
    this.lastState = options.transport.state
    this.detachers.push(this.transport.onMessage((bytes) => this.onFrame(bytes)))
    this.detachers.push(this.transport.onStateChange((state) => this.onState(state)))
  }

  // ───────────────────────────── 我实现的、供对方调用 ─────────────────────────────

  /** 注册一个 handler；返回注销函数。 */
  handle(method: string, fn: RpcHandler): () => void {
    this.handlers.set(method, fn)
    return () => {
      if (this.handlers.get(method) === fn) this.handlers.delete(method)
    }
  }

  /** 订阅一个 topic；返回取消订阅函数。 */
  subscribe(topic: string, fn: EventSubscriber): () => void {
    let set = this.subscribers.get(topic)
    if (!set) {
      set = new Set()
      this.subscribers.set(topic, set)
    }
    set.add(fn)
    return () => {
      set.delete(fn)
      if (set.size === 0) this.subscribers.delete(topic)
    }
  }

  // ───────────────────────────── 我发起的调用 / 我发出的事件 ─────────────────────────────

  /**
   * 发起一次 RPC。链路非 open → **立即失败**（不发请求、不等待）。
   * 长任务不要等它 resolve：见 §3.3，`host.session.send` 只回「投递确认」，过程靠事件推。
   */
  call(method: string, params?: unknown, options?: CallOptions): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new BridgeError('E_INTERNAL', 'endpoint disposed'))
    }
    if (this.transport.state !== 'open') {
      return Promise.reject(new BridgeError('E_TRANSPORT', `transport is ${this.transport.state}`))
    }
    const requestId = newRequestId()
    const call: WireCall = { requestId, method, params }
    const frames = encodeFrames(FrameKind.CALL, this.nextMsgId(), call, this.maxFramePayload)

    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingCall = { requestId, method, frames, resolve, reject }
      const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(requestId)) {
            reject(new BridgeError('E_TIMEOUT', `${method} timed out after ${timeoutMs}ms`))
          }
        }, timeoutMs)
      }
      this.pending.set(requestId, entry)
      this.sendFrames(frames)
    })
  }

  /** 发出一个事件（fire-and-forget）；返回是否发出。 */
  emit(topic: string, payload?: unknown): boolean {
    if (this.disposed || this.transport.state !== 'open') return false
    const event: WireEvent = { topic, payload }
    this.sendFrames(encodeFrames(FrameKind.EVENT, this.nextMsgId(), event, this.maxFramePayload))
    return true
  }

  /** 发送一个心跳 ping（pong 由对端应答）。 */
  ping(): boolean {
    if (this.disposed || this.transport.state !== 'open') return false
    this.sendCtrl({ subtype: 'ping', ts: Date.now() })
    return true
  }

  dispose(reason = 'endpoint disposed'): void {
    if (this.disposed) return
    this.disposed = true
    for (const detach of this.detachers) {
      try {
        detach()
      } catch {
        /* 忽略 */
      }
    }
    const error = new BridgeError('E_TRANSPORT', reason)
    for (const entry of this.pending.values()) {
      this.clearPendingTimer(entry)
      entry.reject(error)
    }
    this.pending.clear()
  }

  get pendingCount(): number {
    return this.pending.size
  }

  get transportState(): TransportState {
    return this.transport.state
  }

  // ───────────────────────────── 接收入口 ─────────────────────────────

  private onFrame(bytes: Uint8Array): void {
    if (this.disposed) return
    let message: ReturnType<Reassembler['accept']>
    try {
      message = this.reassembler.accept(bytes)
    } catch {
      // 坏帧/坏分片直接丢弃，不影响后续
      return
    }
    if (!message) return
    if (message.header.version !== PROTOCOL_VERSION) return // 版本不符：丢弃

    switch (message.header.kind) {
      case FrameKind.CALL:
        void this.onCall(message.payload as WireCall)
        break
      case FrameKind.RESULT:
        this.onResult(message.payload as WireResult)
        break
      case FrameKind.EVENT:
        this.onEvent(message.payload as WireEvent)
        break
      case FrameKind.CTRL:
        this.onCtrl(message.payload as WireCtrl)
        break
    }
  }

  private async onCall(call: WireCall): Promise<void> {
    if (!call || typeof call.requestId !== 'string' || typeof call.method !== 'string') return

    // 幂等：命中去重表则回上次结果，**不重放**
    const cached = this.lookupDedupe(call.requestId)
    if (cached) {
      this.sendResult(cached.result)
      return
    }

    const handler = this.handlers.get(call.method)
    if (!handler) {
      this.finishCall(call.requestId, {
        requestId: call.requestId,
        ok: false,
        error: new BridgeError('E_UNSUPPORTED', `unsupported method: ${call.method}`).toWire(),
      })
      return
    }

    let result: WireResult
    try {
      const data = await handler(call.params, {
        requestId: call.requestId,
        method: call.method,
        origin: 'remote',
      })
      result = { requestId: call.requestId, ok: true, data }
    } catch (err) {
      const error = toBridgeError(err)
      result = { requestId: call.requestId, ok: false, error: error.toWire() }
    }
    this.finishCall(call.requestId, result)
  }

  private onResult(result: WireResult): void {
    if (!result || typeof result.requestId !== 'string') return
    const entry = this.pending.get(result.requestId)
    if (!entry) return // 未知/超时后的迟到响应：忽略
    this.pending.delete(result.requestId)
    this.clearPendingTimer(entry)
    if (result.ok) {
      entry.resolve(result.data)
    } else if (result.error) {
      entry.reject(BridgeError.fromWire(result.error))
    } else {
      entry.reject(new BridgeError('E_INTERNAL', 'malformed RESULT (ok=false without error)'))
    }
  }

  private onEvent(event: WireEvent): void {
    if (!event || typeof event.topic !== 'string') return
    const set = this.subscribers.get(event.topic)
    if (!set) return
    const ctx: EventContext = { topic: event.topic, origin: 'remote' }
    for (const fn of [...set]) {
      try {
        fn(event.payload, ctx)
      } catch {
        // 单个订阅者抛错不得中断分发
      }
    }
  }

  private onCtrl(ctrl: WireCtrl): void {
    if (!ctrl || typeof ctrl.subtype !== 'string') return
    if (ctrl.subtype === 'ping') {
      this.sendCtrl({ subtype: 'pong', ts: ctrl.ts })
    }
    // 'pong' 由心跳逻辑消费（M2/M3）；一期无自动心跳
  }

  // ───────────────────────────── 内部工具 ─────────────────────────────

  private onState(state: TransportState): void {
    const was = this.lastState
    this.lastState = state
    if (state === 'open' && was !== 'open') {
      // 断线期间的分片已失效，重置归组器再重放
      this.reassembler.reset()
      this.replayPending()
    }
  }

  /** 链路恢复：未决的 CALL 用同一 requestId 重发（对端靠去重表返回上次结果）。 */
  private replayPending(): void {
    for (const entry of this.pending.values()) {
      this.sendFrames(entry.frames)
    }
  }

  private finishCall(requestId: string, result: WireResult): void {
    this.rememberDedupe(requestId, result)
    this.sendResult(result)
  }

  private sendResult(result: WireResult): void {
    this.sendFrames(encodeFrames(FrameKind.RESULT, this.nextMsgId(), result, this.maxFramePayload))
  }

  private sendCtrl(ctrl: WireCtrl): void {
    this.sendFrames(encodeFrames(FrameKind.CTRL, this.nextMsgId(), ctrl, this.maxFramePayload))
  }

  private sendFrames(frames: Uint8Array[]): void {
    if (this.transport.state !== 'open') return
    for (const frame of frames) this.transport.send(frame)
  }

  private nextMsgId(): number {
    this.msgId = (this.msgId + 1) >>> 0
    if (this.msgId === 0) this.msgId = 1
    return this.msgId
  }

  private clearPendingTimer(entry: PendingCall): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }

  private lookupDedupe(requestId: string): DedupeEntry | undefined {
    const entry = this.dedupe.get(requestId)
    if (!entry) return undefined
    if (Date.now() - entry.at > this.dedupeTtlMs) {
      this.dedupe.delete(requestId)
      return undefined
    }
    return entry
  }

  private rememberDedupe(requestId: string, result: WireResult): void {
    this.dedupe.set(requestId, { result, at: Date.now() })
    while (this.dedupe.size > this.dedupeSize) {
      const oldest = this.dedupe.keys().next().value
      if (oldest === undefined) break
      this.dedupe.delete(oldest)
    }
  }
}
