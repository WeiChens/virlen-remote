/**
 * 配对载荷（二维码 / 配对串的内容）—— **两端同一份**（M6，见 docs/phone-control-bridge.md §30.2）。
 *
 * 为什么搬到共享包：此前电脑端 `pairingPayload()` 与手机端 `parsePayload()` 各写一份 interface，
 * 字段含义靠注释对齐 —— 这类「契约写两份」的分叉只会在真机上暴露（§26/§29 都是这个形状的缺陷）。
 *
 * 字段：
 * - `host`：**电脑设备 key**（`dk-…`；M3 的旧码是 `host-…`，同样能解析）。
 * - `ticket`：**一次性**配对票据（不是长期凭证！兑换后电脑端签发 `grant` 回传，见 §30.3）。
 * - `signal`：信令基址；缺省 = 同源 Broadcast 联调（生产必有）。
 * - `room`：信令房间号；**缺省由 `roomFor(host)` 派生**。保留字段只为兼容旧码。
 */
import { roomFor } from './identity'

/** 当前载荷版本。v1 与 v2 形状相同（差异在语义：v2 起 `host` 是设备 key、`ticket` 是一次性票据）。 */
export const PAIRING_PAYLOAD_VERSION = 2

/**
 * 配对票据有效期（默认 5 分钟）。
 *
 * 用户反馈「扫码后提示二维码失效」时的值曾是 2 分钟；现在 **5 分钟 + 面板打开即重生成 +
 * 到期自动重生成**（见 `phoneControlStore`）三管齐下，真机上基本不可能再扫到过期码。
 */
export const PAIRING_TICKET_TTL_MS = 5 * 60 * 1000

export interface PairingPayload {
  v: number
  /** 电脑设备 key（也是房间号的来源）。 */
  host: string
  /** 电脑显示名（手机列表里显示）。 */
  name: string
  /** 一次性配对票据。 */
  ticket: string
  /** 信令基址（如 `https://virlen.cn/api/rtc/`）。 */
  signal?: string
  /** 信令房间号（缺省 `roomFor(host)`；旧码里带着它）。 */
  room?: string
}

/** 构造载荷（只填必要字段；`room` 交给两端各自派生，避免又多一处可漂移的冗余）。 */
export function buildPairingPayload(input: {
  host: string
  name: string
  ticket: string
  signal?: string
}): PairingPayload {
  return {
    v: PAIRING_PAYLOAD_VERSION,
    host: input.host,
    name: input.name,
    ticket: input.ticket,
    ...(input.signal ? { signal: input.signal } : {}),
  }
}

/** 序列化为二维码内容。 */
export function encodePairingPayload(payload: PairingPayload): string {
  return JSON.stringify(payload)
}

/**
 * 解析二维码 / 配对串。无法识别返回 `null`（调用方给「不是 Virlen 配对码」的文案）。
 *
 * 宽容点（都是真机上会遇到的东西）：
 * - `v` 缺省按 1 处理（旧码）；
 * - `name` 缺省回退 `host`；
 * - `ticket` 允许是任意非空串（前缀只作可读性，不作校验 —— 电脑端的判定才是权威）。
 */
export function parsePairingPayload(text: string): PairingPayload | null {
  if (typeof text !== 'string' || !text.trim()) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Partial<PairingPayload>
  if (typeof obj.host !== 'string' || !obj.host.trim()) return null
  if (typeof obj.ticket !== 'string' || !obj.ticket.trim()) return null
  const payload: PairingPayload = {
    v: typeof obj.v === 'number' ? obj.v : 1,
    host: obj.host.trim(),
    name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : obj.host.trim(),
    ticket: obj.ticket.trim(),
  }
  if (typeof obj.signal === 'string' && obj.signal.trim()) payload.signal = obj.signal.trim()
  if (typeof obj.room === 'string' && obj.room.trim()) payload.room = obj.room.trim()
  return payload
}

/** 载荷 → 房间号（显式 `room` 优先，否则由电脑 key 派生）。 */
export function roomOfPayload(payload: PairingPayload): string {
  return payload.room ?? roomFor(payload.host)
}
