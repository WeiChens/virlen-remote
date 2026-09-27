/**
 * 错误模型（见 docs/phone-control-bridge.md §3.4）。
 *
 * 只有 `retryable === true` 才允许 UI 给「重试」按钮。
 * `E_UNSUPPORTED` 是**版本兼容的关键**：老手机调新方法 → 明确报错 → UI 隐藏该功能，
 * **永远不要靠版本号 if-else 分支**。
 */

export type ErrorCode =
  | 'E_BAD_REQUEST' // 参数非法（不可重试）
  | 'E_NOT_FOUND' // 会话/消息不存在（不可重试）
  | 'E_DENIED' // ACL 拒绝 / 未授权（不可重试）
  | 'E_UNSUPPORTED' // 方法不被对端支持（能力协商用，不可重试）
  | 'E_BUSY' // 会话正在工作（可重试）
  | 'E_CONFLICT' // 目标已被处理 / 状态已变（不可重试）
  | 'E_CONFIRM_REQUIRED' // 高风险操作缺二次确认（不可重试）
  | 'E_TIMEOUT' // 超时（可重试）
  | 'E_INTERNAL' // 对端内部错误（不可重试）
  | 'E_TRANSPORT' // 本地：链路不可用（可重试）
  | 'E_REPLACED' // 被顶号：同一台电脑已被另一台手机接管（不可重试，且**禁止自动重连**）

/** 线上（wire）错误形态 —— 可序列化为 JSON。 */
export interface WireError {
  code: ErrorCode
  message: string
  retryable: boolean
  data?: unknown
}

const RETRYABLE: Record<ErrorCode, boolean> = {
  E_BAD_REQUEST: false,
  E_NOT_FOUND: false,
  E_DENIED: false,
  E_UNSUPPORTED: false,
  E_BUSY: true,
  E_CONFLICT: false,
  E_CONFIRM_REQUIRED: false,
  E_TIMEOUT: true,
  E_INTERNAL: false,
  E_TRANSPORT: true,
  E_REPLACED: false,
}

export interface BridgeErrorOptions {
  retryable?: boolean
  data?: unknown
  cause?: unknown
}

export class BridgeError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly data?: unknown

  constructor(code: ErrorCode, message: string, options?: BridgeErrorOptions) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.retryable = options?.retryable ?? RETRYABLE[code] ?? false
    this.data = options?.data
    if (options?.cause !== undefined) {
      // 避免依赖 ES2022 的 ErrorOptions，直接挂 cause 字段
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }

  toWire(): WireError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.data !== undefined ? { data: this.data } : {}),
    }
  }

  static fromWire(w: WireError): BridgeError {
    return new BridgeError(w.code, w.message, { retryable: w.retryable, data: w.data })
  }

  static is(value: unknown): value is BridgeError {
    return value instanceof BridgeError
  }
}

/** 把任意抛出物归一为 BridgeError（非 BridgeError 一律按 E_INTERNAL 处理）。 */
export function toBridgeError(err: unknown): BridgeError {
  if (err instanceof BridgeError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new BridgeError('E_INTERNAL', message, { cause: err })
}
