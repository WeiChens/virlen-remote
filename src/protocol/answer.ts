/**
 * 应答载荷的规范化 —— **手机侧与电脑侧共用同一份**（M4）。
 *
 * 为什么必须共用：手机回答「AI 提问」时，最终要交给引擎的是一个 `ToolResult`
 * （`{ content, uiData }`），而电脑侧 UI 早就定下了这个形态（见 `tool-ui.tsx`）：
 * `content` = `[selected.join(', '), customReply].filter(Boolean).join('；')`。
 *
 * 如果手机侧、电脑侧桥接层、mock 宿主各写一份「怎么拼」，三份必然漂移
 * —— 而漂移的表现是「AI 收到了内容，但消息渲染不出来（`uiData` 缺失）」这种**看不出错在谁**的故障。
 * 故：**唯一实现放这里**，其余全部调用它。
 *
 * 手机端允许三种输入（宽容解析，避免因 UI 形态变化而连带改协议）：
 * - 字符串 → 等价于「自定义回复」；
 * - 字符串数组 → 等价于「选中了这些选项」；
 * - 对象 `{ selected?, customReply? }` → 精确形态（推荐）。
 *
 * 空结果一律返回 `null`（调用方据此回 `invalid-value`）——
 * 给引擎发一条空回执会让 AI 无从判断用户到底选了什么。
 */
import type { AnswerAction, AnswerRejectReason, InteractionDTO } from './api'

export interface ChoiceAnswer {
  content: string
  uiData: { selected: string[]; customReply: string }
}

/** 分隔符：与电脑侧 UI 的 `t('；')` 一致（中文分号）。 */
export const CHOICE_JOINER = '；'

export function normalizeChoiceAnswer(value: unknown): ChoiceAnswer | null {
  let selected: string[] = []
  let customReply = ''

  if (typeof value === 'string') {
    customReply = value.trim()
  } else if (Array.isArray(value)) {
    selected = value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean)
  } else if (value && typeof value === 'object') {
    const v = value as { selected?: unknown; customReply?: unknown }
    if (Array.isArray(v.selected)) {
      selected = v.selected
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter(Boolean)
    }
    if (typeof v.customReply === 'string') customReply = v.customReply.trim()
  } else {
    return null
  }

  if (!selected.length && !customReply) return null
  const parts: string[] = []
  if (selected.length) parts.push(selected.join(', '))
  if (customReply) parts.push(customReply)
  return { content: parts.join(CHOICE_JOINER), uiData: { selected, customReply } }
}

/**
 * 应答动作的**合法性校验** —— 真实电脑侧（`interaction-registry`）与 mock 宿主共用同一份。
 *
 * 为什么放在共享包（M4 教训延续，2026-09-27 真机反馈）：动作「对某类交互是否合法」是**协议语义**，
 * 不是某一端的实现细节。两端各写一份时 mock 会偏宽松 ——
 * 「手机对 AI 提问点取消 → 真实电脑端回 `unsupported-by-host`」这类缺陷在手机端单测里测不出来，
 * 只能等到真机才暴露。
 *
 * 判据（与桌面 `tool-ui.tsx` 的按钮一一对应）：
 * - `choice`（AI 提问）：`choose` 确认 / `deny` 取消 / `shelve` 暂存；`allow` 无意义；
 * - `authorization`（授权）：`allow` / `deny` / `shelve`；`choose` 无意义；
 * - `authorization + presentation: 'terminal'`（终端内确认）：**没有暂存语义**
 *   （它是「命令已就绪，等你按回车」，没有可暂存的对象）。
 *
 * @returns 不合法时返回拒绝原因（固定 `unsupported-by-host`）；合法时返回 `null`。
 */
export function answerActionError(
  interaction: Pick<InteractionDTO, 'kind' | 'presentation'>,
  action: AnswerAction,
): AnswerRejectReason | null {
  if (interaction.kind === 'choice') {
    return action === 'allow' ? 'unsupported-by-host' : null
  }
  if (action === 'choose') return 'unsupported-by-host'
  if (action === 'shelve' && interaction.presentation === 'terminal') {
    return 'unsupported-by-host'
  }
  return null
}
