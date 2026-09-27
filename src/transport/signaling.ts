/**
 * 信令通道抽象 + SSE 实现（对接 virlen-api `/api/rtc`）。
 *
 * 分层理由（docs/phone-control-bridge.md §6）：**RtcTransport 只依赖本接口**，不认识 HTTP/SSE。
 * 于是：
 *   - 单测可注入「环回信令」验证 offer/answer 编排（不碰网络）；
 *   - 将来信令换成 WebSocket / 或挪到 Rust，**只换一个实现**。
 *
 * 协议（virlen-api `/api/rtc`，M6 设备房间语义，见 §30.3）：
 *   POST  join   { room, role, deviceKey?, clientName? }
 *                → { id, room, role, ip, hostOnline, peers }
 *   GET   events ?room&id
 *                → SSE：{ type: 'peers' | 'peer-joined' | 'peer-left' | 'signal' | 'kicked' }
 *   POST  signal { room, from, to, data }
 *   POST  status { rooms: string[] }   → { rooms: RoomStatus[] }（批量在线查询，不占房间）
 *
 * 角色语义（**M6 起服务器强制**）：
 *   - `room` 由**电脑设备 key** 派生（`roomFor`），不再由客户端自定；
 *   - 同一房间**最多一个 host、一个 guest**；新 guest 加入会**顶掉**旧 guest（旧端收 `kicked`）；
 *   - 同 key 的 host 重入 = 接管（电脑重启后旧连接多是死连接）。
 */
import { BridgeError } from '../protocol/errors'
import { roomFor, type RoomStatus } from '../protocol/identity'

export type SignalingRole = 'host' | 'guest'

/** 被顶号的通知内容（服务器 `kicked` 事件）。 */
export interface KickedInfo {
  /** `replaced` = 同一台电脑已有新的手机接入（本端被顶掉）；`takeover` = 电脑端重入接管。 */
  reason: string
}

/** `EventSource` 的最小形状（注入测试替身用）。 */
export interface EventSourceLike {
  onopen: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  onmessage: ((event: { data: string }) => void) | null
  close(): void
}

export interface SignalingChannel {
  readonly selfId: string
  readonly peerId: string | null
  onPeer: ((peerId: string | null) => void) | null
  onData: ((data: unknown) => void) | null
  onError: ((error: Error) => void) | null
  /**
   * 本端被服务端顶号（**不是**普通掉线）。
   *
   * 为什么必须独立成回调而不是兼做 `onError`：上层要做出**完全相反的动作** ——
   * 普通掉线自动重连，被顶号**绝不能自动重连**（否则两台手机会互相顶来顶去）。
   */
  onKicked: ((info: KickedInfo) => void) | null
  /** 加入房间；返回本端 id。 */
  join(): Promise<string>
  /** 把一条信令发给当前对端（无对端时 no-op）。 */
  send(data: unknown): Promise<void>
  close(): void
}

export interface SseSignalingOptions {
  /** 信令基址，如 `https://virlen.cn/api/rtc/`（末尾斜杠可有可无）。 */
  baseUrl: string
  room: string
  role: SignalingRole
  /** 本端设备 key（电脑 `dk-…` / 手机 `mk-…`）；服务器用于日志与 host 房主校验。 */
  deviceKey?: string
  /** 本端显示名（服务器日志可读性）。 */
  clientName?: string
  /**
   * 加入时要求房间内已有 host（手机端用）。
   * 无 host 时 `join()` 直接抛错 —— 比「先占住 guest 位再等 15 秒超时」诚实得多。
   */
  requireHostOnline?: boolean
  /** 注入（测试用）；默认取全局 `fetch`。 */
  fetchImpl?: typeof fetch
  /** 注入（测试用）；默认 `(url) => new EventSource(url)`。 */
  eventSourceFactory?: (url: string) => EventSourceLike
}

interface JoinResponse {
  id: string
  room: string
  role: string
  ip?: string
  peers?: Array<{ id: string; role: string }>
  /** 加入时房间里是否已有 host（M6）。 */
  hostOnline?: boolean
}

type ServerEvent =
  | { type: 'peers'; peers: Array<{ id: string; role: string }> }
  | { type: 'peer-joined'; peer: { id: string; role: string } }
  | { type: 'peer-left'; id: string }
  | { type: 'signal'; from: string; data: unknown }
  | { type: 'kicked'; reason?: string }

function normalizeBase(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

export class SseSignalingClient implements SignalingChannel {
  selfId = ''
  peerId: string | null = null
  onPeer: ((peerId: string | null) => void) | null = null
  onData: ((data: unknown) => void) | null = null
  onError: ((error: Error) => void) | null = null
  onKicked: ((info: KickedInfo) => void) | null = null

  private readonly base: string
  private es: EventSourceLike | null = null
  private closed = false
  /** 被顶号后置位：此后一切信令发送都无意义（房间已把我们移除）。 */
  private kicked = false

  constructor(private readonly options: SseSignalingOptions) {
    this.base = normalizeBase(options.baseUrl)
  }

  async join(): Promise<string> {
    const res = await this.fetch()(this.base + 'join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        room: this.options.room,
        role: this.options.role,
        ...(this.options.deviceKey ? { deviceKey: this.options.deviceKey } : {}),
        ...(this.options.clientName ? { clientName: this.options.clientName } : {}),
      }),
    })
    if (!res.ok) {
      const detail = await readErrorDetail(res)
      throw new BridgeError('E_TRANSPORT', `信令 join 失败：HTTP ${res.status}${detail}`)
    }
    const info = (await res.json()) as JoinResponse
    this.selfId = info.id
    // 手机端：电脑不在线就别占着 guest 位 —— 直接失败，让上层给「电脑不在线」
    if (this.options.role === 'guest' && this.options.requireHostOnline && info.hostOnline === false) {
      throw new BridgeError('E_TRANSPORT', '电脑不在线（信令房间内没有 host）', {
        data: { reason: 'host-offline' },
      })
    }
    this.openEvents()
    // 房间里可能已有对端（本端后加入）→ 立刻通知，避免只依赖 peer-joined
    const existing = (info.peers ?? []).find((p) => p.id !== this.selfId)
    if (existing) this.setPeer(existing.id)
    return this.selfId
  }

  async send(data: unknown): Promise<void> {
    if (!this.peerId || this.kicked || this.closed) return
    await this.fetch()(this.base + 'signal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        room: this.options.room,
        from: this.selfId,
        to: this.peerId,
        data,
      }),
    }).catch(() => {
      /* 信令转发失败：ICE 会重试/另择候选，不回滚 */
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.es?.close()
    } catch {
      /* 忽略 */
    }
    this.es = null
  }

  private fetch(): typeof fetch {
    if (this.options.fetchImpl) return this.options.fetchImpl
    if (typeof fetch === 'function') return fetch
    throw new BridgeError('E_INTERNAL', '当前环境没有 fetch，未注入 fetchImpl')
  }

  private openEvents(): void {
    const factory = this.options.eventSourceFactory ?? defaultEventSourceFactory()
    const url = `${this.base}events?room=${encodeURIComponent(this.options.room)}&id=${encodeURIComponent(this.selfId)}`
    const es = factory(url)
    es.onopen = () => {
      /* 连接就绪：无操作（首个事件即 peers） */
    }
    es.onerror = () => {
      if (!this.closed) this.onError?.(new Error('信令事件流异常'))
    }
    es.onmessage = (ev) => this.route(ev.data)
    this.es = es
  }

  private route(raw: string): void {
    let msg: ServerEvent
    try {
      msg = JSON.parse(raw) as ServerEvent
    } catch {
      return
    }
    switch (msg.type) {
      case 'peers': {
        const other = msg.peers.find((p) => p.id !== this.selfId)
        if (other) this.setPeer(other.id)
        break
      }
      case 'peer-joined':
        this.setPeer(msg.peer.id)
        break
      case 'peer-left':
        this.setPeer(null)
        break
      case 'kicked':
        this.handleKicked(msg.reason ?? 'replaced')
        break
      case 'signal':
        this.onData?.(msg.data)
        break
      default:
        break
    }
  }

  /**
   * 被顶号：先通知上层（它要据此关掉自动重连），再关掉事件流。
   *
   * 顺序很重要：`onKicked` 里上层会去 `transport.close()`，而 reconnect 的判定
   * 就在那条路径上 —— 先把「被顶号」这个事实告知，再关流，才不会出现「先判定为重连、后知道是顶号」。
   */
  private handleKicked(reason: string): void {
    if (this.kicked) return
    this.kicked = true
    this.peerId = null
    try {
      this.onKicked?.({ reason })
    } finally {
      this.close()
    }
  }

  private setPeer(peerId: string | null): void {
    if (this.peerId === peerId) return
    this.peerId = peerId
    this.onPeer?.(peerId)
  }
}

function defaultEventSourceFactory(): (url: string) => EventSourceLike {
  return (url: string) => {
    const ES = (globalThis as unknown as { EventSource?: new (url: string) => EventSourceLike }).EventSource
    if (!ES) {
      throw new BridgeError('E_INTERNAL', '当前环境没有 EventSource，未注入 eventSourceFactory')
    }
    return new ES(url)
  }
}

/** 从失败的 join 应答里取一句可读的原因（服务器给 `{ error }`）。 */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body?.error === 'string' && body.error) return `（${body.error}）`
  } catch {
    /* 非 JSON 应答：忽略 */
  }
  return ''
}

/** 批量查房间在线状态（**不加入房间**，不占 guest 位）。 */
export interface FetchRoomStatusOptions {
  /** 信令基址，如 `https://virlen.cn/api/rtc/`。 */
  baseUrl: string
  /** 要查的房间号（由 `roomFor(电脑 key)` 派生）。 */
  rooms: string[]
  fetchImpl?: typeof fetch
}

/**
 * 查询一批房间的在线状态。
 *
 * 失败时**返回空数组而不抛错**：手机端列表的「在线状态」只是提示，
 * 信令服务不可用/版本过旧（无 `/status`）时应当退化为「未知」，而不是把整个列表打挂。
 */
export async function fetchRoomStatus(options: FetchRoomStatusOptions): Promise<RoomStatus[]> {
  const rooms = options.rooms.filter((r) => typeof r === 'string' && r)
  if (rooms.length === 0) return []
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  if (!fetchImpl) return []
  try {
    const res = await fetchImpl(normalizeBase(options.baseUrl) + 'status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rooms }),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { rooms?: RoomStatus[] }
    return Array.isArray(body?.rooms) ? body.rooms : []
  } catch {
    return []
  }
}

/** 便利封装：`电脑 key → 在线?`（手机端列表用）。 */
export async function fetchHostOnlineMap(
  baseUrl: string,
  hostKeys: string[],
  fetchImpl?: typeof fetch,
): Promise<Map<string, boolean>> {
  const statuses = await fetchRoomStatus({ baseUrl, rooms: hostKeys.map(roomFor), ...(fetchImpl ? { fetchImpl } : {}) })
  const byRoom = new Map(statuses.map((s) => [s.room, s.hostOnline]))
  const out = new Map<string, boolean>()
  for (const key of hostKeys) out.set(key, byRoom.get(roomFor(key)) ?? false)
  return out
}
