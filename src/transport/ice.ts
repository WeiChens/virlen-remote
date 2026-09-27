/**
 * ICE 配置 —— **取用策略**（M7，§31）与两端同一份实现。
 *
 * ## 为什么要有这个模块
 *
 * 在此之前，TURN 的 `username` / `credential` 是**硬编码在两端源码里**的（`DEFAULT_ICE`）。
 * 两个端都要开源，这就等于把中继带宽白送出去 —— 所以规则改成：
 *
 *   1. **客户端源码里不再有任何 ICE 凭证**，默认值一律向**信令服务**要（`GET <信令基址>/ice`）；
 *   2. 用户可自填 ICE（自建 coturn / 公共 STUN / 企业内网），**自定义优先**；
 *   3. 服务端下发的配置在本地缓存一段时间 —— 信令偶发抖动时不至于退化成「无 STUN 直连」。
 *
 * ## 优先级（`resolveIceServers`）
 *
 * ```
 * 自定义（localStorage['virlen.rtc.ice']，非空且合法）
 *   > 服务端下发的本地缓存（TTL 内）
 *     > 服务端下发（本次现取）
 *       > 过期缓存（拿不到就是拿不到，用旧的也比没有强）
 *         > 空（仅本机候选，局域网可用、跨网多半不可用）
 * ```
 *
 * ## 为什么放在共享包而不是各端各写一份
 *
 * 与 `pairing.ts` / `identity.ts` 同一个理由（§30.2）：两端口径分叉只会在真机上暴露。
 * 「哪来的 ICE、还剩几个、是不是降级了」在两端必须**用同一套判定与同一套文案**作答。
 *
 * 零运行时依赖；不直接碰 `localStorage`（用注入的 `IceStoragePort`），因此 Node 侧可测。
 */
import { BridgeError } from '../protocol/errors'

/**
 * ICE 服务器条目（`RTCIceServer` 的结构子集）。
 *
 * 刻意**不直接用 DOM 的 `RTCIceServer`**：这个类型要跨端（含 Node 侧的用例）使用，
 * 引 DOM 类型会把「本包需要 DOM lib」这条隐含约束扩散到消费方。结构上完全兼容，
 * 传给 `new RTCPeerConnection({ iceServers })` 无需转换。
 */
export interface IceServerInit {
  urls: string | string[]
  username?: string
  credential?: string
}

/** 服务端应答的版本号（载荷形状变了就 +1，客户端据此决定认不认）。 */
export const ICE_CONFIG_VERSION = 1

/** 相对信令基址的路径：`GET <base>/ice`。 */
export const ICE_API_PATH = 'ice'

/** 用户自定义 ICE 的存放键（与既有 `virlen.rtc.ice` 保持兼容，老用户的自定义配置不丢）。 */
export const ICE_CUSTOM_STORAGE_KEY = 'virlen.rtc.ice'

/** 服务端下发配置的缓存键。 */
export const ICE_REMOTE_STORAGE_KEY = 'virlen.rtc.ice.remote'

/** 下发配置的本地缓存时长（6 小时）—— 够短，跟着服务端改配置走；够长，不每次连接都请求。 */
export const ICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * 取默认值的超时（3 秒）。
 *
 * 刻意**短**：它是连接前的**前置**步骤，卡住就是「用户点连接后干等」。
 * 超时即降级（缓存 / 空），而不是把整个连接流程拖住。
 */
export const ICE_FETCH_TIMEOUT_MS = 3000

/** 存储端口（两端都传 `localStorage`；用例传假实现）。 */
export interface IceStoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 本次实际用的 ICE 从哪来。 */
export type IceSource = 'custom' | 'remote' | 'cache' | 'stale-cache' | 'none'

export interface ResolvedIceServers {
  /** 最终要交给 `RTCPeerConnection` 的列表（可能为空 = 只用本机候选）。 */
  servers: IceServerInit[]
  source: IceSource
  /** 给用户看的一句话（设置页直接渲染）。 */
  detail: string
  /** 降级 / 异常时的补充说明（没有则 `undefined`）。 */
  warning?: string
  /** 自定义配置写了但解析失败时的原因（UI 用来标红，不阻断连接）。 */
  customError?: string
}

/* ------------------------------ 解析 / 清洗 ------------------------------ */

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * 把任意输入清洗成合法的 ICE 列表。
 *
 * 宽容但**不猜**：`urls` 必须是字符串或字符串数组（至少一项非空），
 * `username` / `credential` 只在是字符串时保留 —— 其余一律丢弃。
 * 与其让一个坏条目把 `new RTCPeerConnection()` 整个搞崩（浏览器直接抛错），
 * 不如在这里筛掉：ICE 少一个服务器只是连通性变差，抛错则是功能完全不可用。
 *
 * ⚠️ **保留 `urls` 的书写形状**（数组就还是数组）：清洗结果会回填到设置页文本框
 * （`readCustomIceText`），把 `['a']` 折叠成 `'a'` 会让用户改过的配置莫名其妙变形。
 */
export function sanitizeIceServers(input: unknown): IceServerInit[] {
  if (!Array.isArray(input)) return []
  const out: IceServerInit[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<IceServerInit>
    const urls: string | string[] | null = Array.isArray(item.urls)
      ? item.urls.filter(isNonEmptyString).map((u) => u.trim())
      : isNonEmptyString(item.urls)
        ? item.urls.trim()
        : null
    if (urls === null || (Array.isArray(urls) && urls.length === 0)) continue
    const entry: IceServerInit = { urls }
    if (isNonEmptyString(item.username)) entry.username = item.username
    if (isNonEmptyString(item.credential)) entry.credential = item.credential
    out.push(entry)
  }
  return out
}

export type ParseIceResult = { ok: true; servers: IceServerInit[] } | { ok: false; error: string }

/**
 * 解析用户手填的 ICE JSON（设置页文本框）。
 *
 * 空串 = 「用服务端默认」，不算错误（UI 也据此判断「已自定义 / 未自定义」）。
 */
export function parseIceText(text: string): ParseIceResult {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { ok: false, error: '未填写' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: '不是合法 JSON' }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: '顶层必须是数组，例如 [{"urls":"stun:…"}]' }
  const servers = sanitizeIceServers(parsed)
  if (servers.length === 0) {
    return { ok: false, error: '没有可用的条目（每项至少要有非空的 urls）' }
  }
  return { ok: true, servers }
}

/** 回填文本框：把当前生效的列表格式化成可编辑的 JSON（用户改之前先看得见现状）。 */
export function formatIceServers(servers: IceServerInit[]): string {
  return JSON.stringify(servers, null, 2)
}

/* ------------------------------ 文案 ------------------------------ */

/** 来源 → 用户可读文案（两端共用，避免「服务端下发」与「服务器配置」两种说法打架）。 */
export function describeIceSource(source: IceSource, count: number): string {
  switch (source) {
    case 'custom':
      return `自定义 ICE（${count} 个服务器）`
    case 'remote':
      return `服务端下发（${count} 个服务器）`
    case 'cache':
      return `服务端下发 · 本地缓存（${count} 个服务器）`
    case 'stale-cache':
      return `服务端下发 · 过期缓存（${count} 个服务器）`
    default:
      return '未配置 ICE（仅本机候选，跨网可能连不上）'
  }
}

/* ------------------------------ 取服务端默认值 ------------------------------ */

export interface FetchIceOptions {
  /** 信令基址，如 `https://virlen.cn/api/rtc/`（末尾斜杠可有可无）。 */
  baseUrl: string
  fetchImpl?: typeof fetch
  /** 默认 `ICE_FETCH_TIMEOUT_MS`。 */
  timeoutMs?: number
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

/**
 * 向信令服务要默认 ICE。
 *
 * @returns 服务端给出的列表；**取不到返回 `null`**（与「服务端明确说没有」区分开）。
 *
 * 为什么区分：`[]` 是「服务端回答了：没配」→ 不该继续拿旧缓存；
 * `null` 是「没问到」→ 旧缓存反而是当前最好的答案。
 */
export async function fetchIceServers(options: FetchIceOptions): Promise<IceServerInit[] | null> {
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  if (!fetchImpl) return null
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller
    ? setTimeout(() => controller.abort(), options.timeoutMs ?? ICE_FETCH_TIMEOUT_MS)
    : null
  try {
    const res = await fetchImpl(normalizeBase(options.baseUrl) + ICE_API_PATH, {
      method: 'GET',
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    // 宽容两种形状：`{ iceServers: [...] }`（现行）与裸数组（更早/更简的部署）
    const list = Array.isArray(body)
      ? body
      : ((body as { iceServers?: unknown } | null)?.iceServers ?? null)
    if (list === null) return null
    return sanitizeIceServers(list)
  } catch {
    // 网络不通 / 超时 / 非 JSON：都归为「没问到」
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/* ------------------------------ 解析（对外主入口） ------------------------------ */

export interface ResolveIceOptions {
  /** 信令基址；缺省则跳过「现取」这一步（只用自定义 / 缓存）。 */
  baseUrl?: string
  /** 用户自定义的 JSON 文本；空 / 非法则走下一优先级。 */
  customText?: string | null
  storage?: IceStoragePort | null
  fetchImpl?: typeof fetch
  /** 注入「现在」（用例用）。 */
  now?: number
  cacheTtlMs?: number
  timeoutMs?: number
}

function readCache(
  storage: IceStoragePort | null | undefined,
  now: number,
  ttlMs: number,
): { servers: IceServerInit[]; fresh: boolean } | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(ICE_REMOTE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { at?: unknown; servers?: unknown }
    const servers = sanitizeIceServers(parsed?.servers)
    if (servers.length === 0) return null
    const at = typeof parsed?.at === 'number' ? parsed.at : 0
    return { servers, fresh: now - at <= ttlMs }
  } catch {
    return null
  }
}

function writeCache(storage: IceStoragePort | null | undefined, now: number, servers: IceServerInit[]): void {
  if (!storage) return
  try {
    storage.setItem(ICE_REMOTE_STORAGE_KEY, JSON.stringify({ at: now, servers }))
  } catch {
    /* 存储不可用（隐私模式 / 配额满）：缓存丢了下一次再取，不影响本次连接 */
  }
}

/**
 * 解析出**本次连接实际要用**的 ICE 列表（两端唯一的入口）。
 *
 * 永不抛错：任何一步失败都降级到下一优先级 ——「拿不到 TURN 配置」不该让用户连不上电脑，
 * 只该让跨网连通率变差（并由 `detail` / `warning` 如实告诉用户）。
 */
export async function resolveIceServers(options: ResolveIceOptions = {}): Promise<ResolvedIceServers> {
  const now = options.now ?? Date.now()

  // ① 自定义优先：用户填了就以用户的为准（自建 coturn / 内网 STUN 都靠它）
  const customText = options.customText ?? null
  let customError: string | undefined
  if (customText && customText.trim()) {
    const parsed = parseIceText(customText)
    /*
     * ⚠️ 必须写 `parsed.ok === false` 而不是 `if (!parsed.ok)`：
     * 消费方 `virlen-app/tsconfig.json` 里是 `strictNullChecks: false`，此时 TS 对
     * **布尔判别字段的真值判断不收敛联合类型**（详见 docs/phone-control-bridge.md 的踩坑记录）。
     */
    if (parsed.ok === false) {
      // 非法配置：**不阻断**，降级到服务端默认，同时把原因带出去让 UI 标红
      customError = parsed.error
    } else {
      return {
        servers: parsed.servers,
        source: 'custom',
        detail: describeIceSource('custom', parsed.servers.length),
      }
    }
  }

  // ② 服务端下发的本地缓存（TTL 内）
  const cached = readCache(options.storage, now, options.cacheTtlMs ?? ICE_CACHE_TTL_MS)
  if (cached?.fresh) {
    return {
      servers: cached.servers,
      source: 'cache',
      detail: describeIceSource('cache', cached.servers.length),
      ...(customError ? { customError } : {}),
    }
  }

  // ③ 现取
  if (options.baseUrl) {
    const fetched = await fetchIceServers({
      baseUrl: options.baseUrl,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    })
    if (fetched && fetched.length > 0) {
      writeCache(options.storage, now, fetched)
      return {
        servers: fetched,
        source: 'remote',
        detail: describeIceSource('remote', fetched.length),
        ...(customError ? { customError } : {}),
      }
    }
    if (fetched && fetched.length === 0) {
      // 服务端明确回答「没配」：此时再拿旧缓存是自欺欺人（配置已被撤下）
      return {
        servers: [],
        source: 'none',
        detail: describeIceSource('none', 0),
        warning: '服务端未下发 ICE 配置',
        ...(customError ? { customError } : {}),
      }
    }
  }

  // ④ 取不到：过期缓存也比没有强（TURN 凭证通常变化不大）
  if (cached) {
    return {
      servers: cached.servers,
      source: 'stale-cache',
      detail: describeIceSource('stale-cache', cached.servers.length),
      warning: '信令服务暂不可达，先用上次缓存',
      ...(customError ? { customError } : {}),
    }
  }

  return {
    servers: [],
    source: 'none',
    detail: describeIceSource('none', 0),
    warning: options.baseUrl ? '信令服务暂不可达' : '未配置信令服务',
    ...(customError ? { customError } : {}),
  }
}

/**
 * 读取「用户自定义」文本框的初始内容（设置页打开时回填）。
 *
 * 坏数据（非 JSON / 非数组）按「没填」处理：让用户看到一个空框，而不是一段乱码。
 */
export function readCustomIceText(storage: IceStoragePort | null | undefined): string {
  if (!storage) return ''
  try {
    const raw = storage.getItem(ICE_CUSTOM_STORAGE_KEY)
    if (!raw || !raw.trim()) return ''
    const parsed = JSON.parse(raw) as unknown
    return formatIceServers(sanitizeIceServers(parsed))
  } catch {
    return ''
  }
}

/**
 * 写入 / 清除用户自定义 ICE。
 *
 * 空文本 = 清除（回到服务端默认）。**先校验再落盘**：让错误在保存那一刻暴露，
 * 而不是等到某次真机连接失败才发现自己少写了一个引号。
 */
export function writeCustomIceText(
  storage: IceStoragePort | null | undefined,
  text: string,
): { ok: true } | { ok: false; error: string } {
  const trimmed = (text ?? '').trim()
  if (!trimmed) {
    try {
      storage?.setItem(ICE_CUSTOM_STORAGE_KEY, '')
    } catch {
      /* 忽略 */
    }
    return { ok: true }
  }
  const parsed = parseIceText(trimmed)
  // 同 `resolveIceServers`：`=== false` 而非 `!parsed.ok`（消费方关了 strictNullChecks）
  if (parsed.ok === false) return { ok: false, error: parsed.error }
  if (!storage) return { ok: false, error: '当前环境不支持本地存储' }
  try {
    storage.setItem(ICE_CUSTOM_STORAGE_KEY, formatIceServers(parsed.servers))
  } catch (err) {
    return { ok: false, error: new BridgeError('E_INTERNAL', String(err)).message }
  }
  return { ok: true }
}
