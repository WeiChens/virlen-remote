/**
 * 设备身份与授权凭证（M6，见 docs/phone-control-bridge.md §30）。
 *
 * 一句话：**设备 key 是「谁」，授权凭证是「凭什么是它」。**
 *
 * - **设备 key**：首次运行生成一次，之后**持久化不变**（手机写 localStorage，电脑写
 *   `<data_dir>/phone-device.json`）。它不是硬件指纹 —— 见 §30.1 的取舍说明：
 *   PWA 拿不到可靠的硬件指纹（浏览器升级 / 隐私模式 / 清数据即变，同型号还会撞），
 *   所以唯一能同时满足「不重复」与「重新获取还是同一个」的做法就是随机生成 + 落盘。
 * - **房间号**由电脑设备 key 派生（`roomFor`）：于是「第二次连接」只需要拿电脑 key 去问
 *   信令服务「这台电脑在不在线」，不必再扫码。
 * - **授权凭证**（grant）：由**电脑端**签发，绑定手机设备 key，默认 30 天有效、
 *   每次成功连接**滑动续期**，但单次签发最长 `GRANT_MAX_LIFETIME_MS`（90 天）——
 *   到顶后必须重新扫码授权（用户 2026-09-27 拍板）。
 *
 * 本模块**零依赖、两端同一份**：电脑端与手机端都必须用这里的常量与判定函数，
 * 否则必然出现「一端认为有效、另一端认为过期」的分叉（§18.5 的教训）。
 */

/** 电脑设备 key 前缀（desktop key）。 */
export const HOST_KEY_PREFIX = 'dk-'
/** 手机设备 key 前缀（mobile key）。 */
export const MOBILE_KEY_PREFIX = 'mk-'
/** 授权凭证前缀（grant）。 */
export const GRANT_PREFIX = 'gt-'

/** 授权凭证的单次续期时长（30 天）。 */
export const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 单次签发的**最长寿命**（90 天，从 `issuedAt` 起算）。
 *
 * 为什么要有硬上限：滑动续期若没有上限，一个凭证就等于永久授权 —— 手机丢失/被借用时
 * 电脑端的「移除」是唯一刹车，而用户未必想得起来去看那张列表。
 */
export const GRANT_MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000

/** 房间名前缀（信令层）。与 M3 起的旧房间名同构：`virlen:<电脑标识>`。 */
export const ROOM_PREFIX = 'virlen:'

export type DeviceKind = 'host' | 'mobile'

/**
 * 一条授权凭证（电脑侧是**真源**，手机侧存副本）。
 *
 * `token` 在续期时**保持不变**（只推后 `expiresAt`）—— 凭证字符串是「这次配对」的身份，
 * 每次连接都换新串会让重连路径（内存里的 `lastOptions` / 本地存储的写入时序）出现
 * 「用旧串连、被判无效」的窗口。要换串只有一种场景：**重新扫码**（新签发）。
 */
export interface GrantRecord {
  token: string
  /** 首次签发时刻（硬上限 `GRANT_MAX_LIFETIME_MS` 据此起算）。 */
  issuedAt: number
  /** 当前到期时刻（滑动续期会推后，但不超过 `issuedAt + 硬上限`）。 */
  expiresAt: number
  /** 最近一次成功连接时刻（电脑端列表展示用）。 */
  lastSeenAt?: number
}

/** 凭证被拒的原因（线上随 `E_DENIED` 的 `data.reason` 回传，手机据此给不同文案）。 */
export type CredentialRejectReason = 'invalid' | 'expired' | 'revoked'

/** 房间在线状态（信令服务 `POST /status` 的应答元素）。 */
export interface RoomStatus {
  room: string
  /** 电脑端是否在线（有 host 角色的活跃连接）。 */
  hostOnline: boolean
  /** 是否已有手机占着 guest 位（第二台手机会顶掉它，见 §30.3）。 */
  guestOnline: boolean
  /** host / guest 的加入时刻（毫秒；不在线则缺省）。 */
  hostSince?: number
  guestSince?: number
}

/** 生成 `prefix + 十六进制随机串`（默认 16 字节 = 32 hex）。 */
export function randomKey(prefix: string, bytes = 16): string {
  const buf = new Uint8Array(bytes)
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(buf)
  } else {
    // 无 WebCrypto 的环境（老 Node / 极端降级）：Math.random 兜底。
    // ⚠️ 只用于「本地身份标识」，不是加密码 —— 真正的安全边界是授权凭证与电脑端确认弹窗。
    for (let i = 0; i < buf.length; i += 1) buf[i] = Math.floor(Math.random() * 256)
  }
  let out = prefix
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}

/** 生成一个设备 key（`host` → `dk-…`，`mobile` → `mk-…`）。 */
export function newDeviceKey(kind: DeviceKind): string {
  return randomKey(kind === 'host' ? HOST_KEY_PREFIX : MOBILE_KEY_PREFIX)
}

/** 生成一个授权凭证串。 */
export function newGrantToken(): string {
  return randomKey(GRANT_PREFIX, 24)
}

const KEY_RE = /^(dk|mk)-[0-9a-f]{8,64}$/

/**
 * 是否为合法设备 key。`kind` 不传则不校验前缀归属。
 *
 * 只用于**早期拒掉明显是垃圾的输入**（日志可读、列表可渲染），不是安全校验 ——
 * 真正的授权判定在电脑端的凭证表。
 */
export function isDeviceKey(value: unknown, kind?: DeviceKind): value is string {
  if (typeof value !== 'string' || !KEY_RE.test(value)) return false
  if (!kind) return true
  return value.startsWith(kind === 'host' ? HOST_KEY_PREFIX : MOBILE_KEY_PREFIX)
}

/**
 * 电脑设备 key → 信令房间号。
 *
 * ⚠️ 兼容 M3 的旧房间名：旧 `hostId`（如 `host-ab12cd34`，无前缀）传进来同样得到
 * `virlen:host-ab12cd34` —— 与旧实现逐字一致，于是**旧二维码仍然可用**（§30.6）。
 */
export function roomFor(hostKey: string): string {
  return ROOM_PREFIX + hostKey
}

/** 房间号 → 电脑设备 key（非本前缀派生时返回 `null`）。 */
export function hostKeyFromRoom(room: string): string | null {
  if (typeof room !== 'string' || !room.startsWith(ROOM_PREFIX)) return null
  const key = room.slice(ROOM_PREFIX.length)
  return key ? key : null
}

/** 签发一条新凭证（`now` 可注入，便于测试）。 */
export function issueGrant(now: number = Date.now()): GrantRecord {
  return {
    token: newGrantToken(),
    issuedAt: now,
    expiresAt: now + GRANT_TTL_MS,
    lastSeenAt: now,
  }
}

/** 凭证是否已过期。 */
export function isGrantExpired(grant: GrantRecord, now: number = Date.now()): boolean {
  return now >= grant.expiresAt
}

/**
 * 滑动续期：把到期时间推后到 `now + 30 天`，但**不超过** `issuedAt + 90 天`。
 *
 * 返回新对象（不原地改），调用方负责持久化 —— 「算」与「存」分开，便于测试与审计。
 */
export function renewGrant(grant: GrantRecord, now: number = Date.now()): GrantRecord {
  const cap = grant.issuedAt + GRANT_MAX_LIFETIME_MS
  return {
    ...grant,
    expiresAt: Math.min(now + GRANT_TTL_MS, cap),
    lastSeenAt: now,
  }
}

/**
 * 凭证可用性判定（**两端共用**）。
 * 返回 `null` = 可用；否则是拒绝原因。
 */
export function checkGrant(
  grant: GrantRecord | null | undefined,
  now: number = Date.now(),
): CredentialRejectReason | null {
  if (!grant || typeof grant.token !== 'string' || !grant.token) return 'invalid'
  if (isGrantExpired(grant, now)) return 'expired'
  return null
}

/** 剩余有效期的自然语言（两端 UI 共用同一套口径，避免「还剩 3 天」与「2.9 天」打架）。 */
export function describeGrantRemaining(grant: { expiresAt: number }, now: number = Date.now()): string {
  const left = grant.expiresAt - now
  if (left <= 0) return '已过期'
  const days = Math.floor(left / (24 * 60 * 60 * 1000))
  if (days >= 1) return `剩余 ${days} 天`
  const hours = Math.floor(left / (60 * 60 * 1000))
  if (hours >= 1) return `剩余 ${hours} 小时`
  const minutes = Math.max(1, Math.floor(left / 60000))
  return `剩余 ${minutes} 分钟`
}
