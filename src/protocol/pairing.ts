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
 *
 * **线上的码是混淆过的**（见 `PAIRING_OBFUSCATION_PREFIX`）：`encodePairingPayload` 输出
 * `vrp1:` + Base64URL(UTF-8(JSON) ⊕ 固定盐)，使二维码文字 / 界面上的排查文本不再是明文 JSON；
 * `parsePairingPayload` 仍**兼容旧明文码**（无前缀即按原 JSON 解析），已生成 / 已截图的旧码不会失效。
 *
 * **二维码内容是一条 URL**：`https://virlen.cn/mobile?t=<配对数据>`（见 `buildPairingUrl`）。
 * 这样**系统相机 / 微信 / 任意浏览器**扫码都能直接打开手机端并自动配对，无需先装 App 再扫码；
 * App 内的扫码器则用 `parsePairingPayload` 从 URL 里取回 `t`。`parsePairingPayload`
 * **三种输入都吃**：URL、`vrp1:` 混淆串、旧版明文 JSON。
 *
 * ⚠️ 这是**混淆，不是加密**：本包是公开 npm 包、固定盐也在源码里，拿到源码即可解；
 * 且它**挡不住有人对着屏幕拍照**（二维码本就是给人扫的）。真正的安全边界是
 * 「一次性 ticket + 电脑端确认弹窗 + 授权凭证」（见 `identity.ts`）。
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

/**
 * 配对串混淆前缀。
 *
 * - **带此前缀**：内容是 `Base64URL(UTF-8(JSON) ⊕ 固定盐)`，走解码；
 * - **不带**：当作旧版明文 JSON 解析（**向后兼容** —— 线上已生成 / 已截图的旧二维码、
 *   以及老版本手抄的配对串仍能识别，升级后不会突然「无法识别」）。
 *
 * 前缀选 `vrp1:`（virlen pairing v1）—— 明文 JSON 必以 `{` 开头，不可能撞上前缀。
 */
export const PAIRING_OBFUSCATION_PREFIX = 'vrp1:'

/**
 * 配对二维码指向的手机端地址。
 *
 * 二维码内容 = `https://virlen.cn/mobile?t=<配对数据>`：**系统相机 / 微信 / 任意浏览器**扫到后
 * 直接打开手机端，手机端从 `?t=` 取回配对数据即可自动配对 —— 无需先装 App 再扫码。
 *
 * ⚠️ 这是**部署地址**（手机端 PWA 在 `/mobile/`）；自建 / 换域名时由调用方传入 `base` 覆盖。
 */
export const PAIRING_URL_BASE = 'https://virlen.cn/mobile'

/** URL 里承载配对数据的查询参数名。 */
export const PAIRING_URL_PARAM = 't'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * 混淆盐（UTF-8 字节）。
 *
 * ⚠️ **这不是密钥，是固定盐**：本包发布到公开 npm，字符串必然可见、拿到源码即可解。
 * 它只解决「配对串在界面上 / 复制粘贴时不是一眼可读的 JSON」，不提供任何机密性 ——
 * 真正的安全边界是「一次性 ticket + 电脑端确认弹窗 + 授权凭证」（见 `identity.ts`）。
 */
const OBFUSCATION_SALT = textEncoder.encode('virlen/pairing/obfuscation/v1')

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

// ── 混淆编解码（零依赖：自带 Base64URL，不依赖 btoa / atob / Buffer —— 两端 + Node 环境一致）──

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Base64URL 反向查表（ASCII 0–127；其余一律视为非法字符）。 */
const B64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64_ALPHABET.length; i += 1) table[B64_ALPHABET.charCodeAt(i)] = i
  return table
})()

/** 逐字节与盐做 XOR（盐循环使用）—— 可逆，用于混淆。 */
function xorSalt(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  const salt = OBFUSCATION_SALT
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i]! ^ salt[i % salt.length]!
  return out
}

/** Base64URL 编码（**无填充**，`-` / `_` 代替 `+` / `/`）。 */
function base64UrlEncode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === undefined) break
    out += B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === undefined) break
    out += B64_ALPHABET[b2 & 0x3f]
  }
  return out
}

/** Base64URL 解码；含非法字符或长度非法（`len % 4 === 1`）时返回 `null`。 */
function base64UrlDecode(text: string): Uint8Array | null {
  if (!text) return null
  const values: number[] = []
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    const v = code < 128 ? B64_LOOKUP[code]! : -1
    if (v < 0) return null
    values.push(v)
  }
  if (values.length % 4 === 1) return null
  const out = new Uint8Array((values.length * 6) >> 3)
  let o = 0
  for (let i = 0; i < values.length; i += 4) {
    const c0 = values[i]!
    const c1 = values[i + 1]
    const c2 = values[i + 2]
    const c3 = values[i + 3]
    out[o++] = (c0 << 2) | ((c1 ?? 0) >> 4)
    if (c2 === undefined) break
    out[o++] = (((c1 ?? 0) & 0x0f) << 4) | (c2 >> 2)
    if (c3 === undefined) break
    out[o++] = ((c2 & 0x03) << 6) | c3
  }
  return out.subarray(0, o)
}

/** 把 `vrp1:` 串还原成 JSON 文本；任何异常（非法字符 / 长度 / 解码失败）都返回 `null`。 */
function decodeObfuscated(text: string): string | null {
  const bytes = base64UrlDecode(text.slice(PAIRING_OBFUSCATION_PREFIX.length))
  if (!bytes) return null
  return textDecoder.decode(xorSalt(bytes))
}

/** 序列化为二维码内容（**混淆后的串**，不再是明文 JSON）。 */
export function encodePairingPayload(payload: PairingPayload): string {
  const json = textEncoder.encode(JSON.stringify(payload))
  return PAIRING_OBFUSCATION_PREFIX + base64UrlEncode(xorSalt(json))
}

/**
 * 构造成「可被系统相机 / 微信扫开」的配对链接（二维码内容）。
 *
 * @param payload 配对载荷
 * @param base 手机端地址（缺省 {@link PAIRING_URL_BASE}）
 */
export function buildPairingUrl(payload: PairingPayload, base: string = PAIRING_URL_BASE): string {
  const url = new URL(base)
  url.searchParams.set(PAIRING_URL_PARAM, encodePairingPayload(payload))
  return url.toString()
}

/**
 * 从「扫到 / 粘进来的文本」里取出配对数据本体。
 *
 * 三种输入都吃：
 * - **URL**（`https://virlen.cn/mobile?t=<配对数据>`）—— 系统相机 / 微信扫码打开的就是它；
 * - `vrp1:…` 混淆串；
 * - 旧版明文 JSON。
 *
 * 返回 `null` 表示「这里没有配对数据」（比如是别的网址、或 URL 上没带 `t`）。
 */
function pairingCodeFromText(text: string): string | null {
  if (!/^https?:\/\//i.test(text)) return text
  try {
    const code = new URL(text).searchParams.get(PAIRING_URL_PARAM)
    return code && code.trim() ? code.trim() : null
  } catch {
    return null
  }
}

/**
 * 解析二维码 / 配对串 / 配对链接。无法识别返回 `null`（调用方给「不是 Virlen 配对码」的文案）。
 *
 * 宽容点（都是真机上会遇到的东西）：
 * - 输入可以是 `vrp1:…` 串、旧版明文 JSON，或 `…?t=<配对数据>` 的 URL；
 * - `v` 缺省按 1 处理（旧码）；
 * - `name` 缺省回退 `host`；
 * - `ticket` 允许是任意非空串（前缀只作可读性，不作校验 —— 电脑端的判定才是权威）。
 */
export function parsePairingPayload(text: string): PairingPayload | null {
  if (typeof text !== 'string' || !text.trim()) return null
  // 先取出配对数据本体（URL → `?t=`；否则原样）
  const code = pairingCodeFromText(text.trim())
  if (code === null) return null
  // 带前缀 → 先解混淆；否则按旧版明文 JSON 解析（向后兼容，见 PAIRING_OBFUSCATION_PREFIX）
  const jsonText = code.startsWith(PAIRING_OBFUSCATION_PREFIX) ? decodeObfuscated(code) : code
  if (jsonText === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
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
