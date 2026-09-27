/**
 * requestId 生成 —— 零依赖。
 *
 * 用于 RPC 幂等（见 docs/phone-control-bridge.md §3.2）：手机网络会闪断，重连后必然重发，
 * 电脑侧靠 requestId 去重、**返回上次结果而非重放**。
 *
 * 优先用 `crypto.randomUUID()`（浏览器安全上下文 / Node ≥ 19 均可用）；
 * 退化为「时间戳 + 单调计数 + 随机」——**不用于安全用途**，仅需高概率唯一。
 */
let fallbackCounter = 0

export function newRequestId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }
  fallbackCounter = (fallbackCounter + 1) >>> 0
  const rand = Math.random().toString(36).slice(2, 10)
  return `${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${rand}`
}
