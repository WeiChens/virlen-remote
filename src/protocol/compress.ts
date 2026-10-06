/**
 * 上下文压缩方式 —— **两端共用的契约**：取值域 + 能力名。
 *
 * ## 为什么单独一份
 *
 * 「用一次模型调用把历史浓缩成摘要」还是「把整段历史本地重排成一段文本」是**两端各表一半**
 * 的约定：手机端给出选择（`CompressParams.mode`），电脑端执行（Rust `CompressMode`，
 * 落点 `virlen_core::agent::compress`）；产物的差异还要能被界面说清
 * （`ui_data.compressMode`，桌面 `summary-message.tsx` 据此显示「AI 摘要」/「正文压缩」）。
 * 取值域写两份必然漂移 —— 一边 `'summary'`、一边 `'ai'`，而这类不匹配**不报错**，
 * 只表现为「选了没反应」或「压缩方式记成了错的」。
 *
 * ⚠️ 本模块只放**取值域与能力名**，不放用户可见文案：文案归各端 i18n（桌面
 * `src/ui/i18n`，手机端是硬编码中文 UI），共享包是零运行时依赖的协议层。
 *
 * ## 两种方式的实际差别（消费方据此写提示，别写反）
 *
 * - `ai`：一次**非流式模型调用**（`prompts/compress-context.md`），最省 token，但慢、且**要花钱**；
 *   模型违约（调工具 / 空正文）时电脑侧回退 `raw`，但那次调用**照常记账** —— 所以
 *   「这次到底花了钱没有」不能只看产物形态。
 * - `raw`：纯本地渲染（`compress/raw.rs`），毫秒级零消耗；用户 / 助手正文**一字不删**，
 *   只丢深度思考并省略超长工具参数与工具输出 —— 所以产物**可能比 `ai` 长得多**（可达数万字符）。
 */

/** 压缩方式取值（与 Rust `CompressMode::as_str()`、`ui_data.compressMode` 逐字一致）。 */
export type CompressMode = 'ai' | 'raw'

/** 全量取值（顺序 = 界面展示顺序，与 Rust `CompressMode::ALL` 一致：`ai` 在前）。 */
export const COMPRESS_MODES: readonly CompressMode[] = ['ai', 'raw']

/**
 * 请求里**没传** `mode` 时电脑侧实际用哪种 —— 与桌面设置项 `contextCompressMode` 的默认值一致。
 *
 * 消费方注意：这是**缺省**，不是「手机端该默认选它」—— 手机端在旧电脑端（没有下面那个能力名）
 * 上根本不该传 `mode`，此时真正生效的是**电脑侧设置里的那一档**，手机端无从得知。
 */
export const DEFAULT_COMPRESS_MODE: CompressMode = 'ai'

/**
 * 解析压缩方式（**容忍大小写与首尾空白**，与 Rust `CompressMode::parse` 同宽容度）。
 *
 * 为什么返回 `null` 而不是抛错：调用方是「电脑侧 handler 校验手机传来的参数」，它需要区分
 * 「没传」（用缺省）与「传了但不认识」（`E_BAD_REQUEST`）两种情形；手机端则完全不需要运行时
 * 校验 —— 它的取值来自自己的类型化 UI（`CompressParams.mode` 已是 `CompressMode`）。
 */
export function compressModeOf(value: unknown): CompressMode | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return (COMPRESS_MODES as readonly string[]).includes(normalized)
    ? (normalized as CompressMode)
    : null
}

/**
 * 手机端声明它 = 「本端会给用户两种压缩方式的选择，并把选择放进 `CompressParams.mode`」；
 * 电脑端列出它 = 「本机认识 `CompressParams.mode`，会照它执行」。
 *
 * ⚠️ 这是**功能标记**，不是权限（与 §36 的 `MESSAGE_QUOTE_CAPABILITY` 同类）：压缩本身的授权
 * 仍是 `session.compress`（破坏性、需 `confirm:true`，电脑侧独立 `assert`），本能力名只回答
 * 「本机认不认这个参数」。为什么非得有这么一道闸：**已部署的旧电脑端不认 `mode`** ——
 * 它是普通字段，RPC 会正常成功，然后按**电脑侧设置里的方式**压缩。用户侧表现是
 * 「我明明点了『正文压缩』，结果还是走了 AI 摘要（还花了钱）」，且没有任何报错可查。
 * 所以手机端在旧电脑端上**只给一个「压缩上下文」按钮**（走电脑侧设置），不给选择器。
 */
export const COMPRESS_MODE_CAPABILITY = 'session.compress.mode'
