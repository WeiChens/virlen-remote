/**
 * 工具入参摘要 —— 「这一步工具到底在干什么」的**唯一格式化口径**。
 *
 * 为什么单列一个模块：手机屏上一行只放得下一步工具调用，而**哪几个键才是关键入参**是随
 * 工具而变的（`read_file` 看路径、`execute_command` 看命令、`search_text_in_files` 看
 * 「在哪儿搜什么」）。这份知识原先只存在于桌面端的 28 个 `getShortText()` 组件里 ——
 * 手机端拿不到，于是真机反馈是「工具气泡只有工具名，看不到编辑的是哪个文件、执行的是什么命令」。
 *
 * 三条纪律（与桌面 `tool-call/primary-path.ts` 同源）：
 *
 * 1. **按工具名取键**：键名以 `tool_defs/definitions.json` 为准（那是权威契约，本文件
 *    只挑「主参数」）——不用「给每个工具加一个方法」那种写法，那是把同一件事抄 28 遍；
 * 2. **拿不到就不猜**：没有可用的关键入参 → `undefined`，手机端只显示工具名（宁可不显示，
 *    也不要显示一句听起来像那么回事的假话）；
 * 3. **只给摘要，不给原文**：`write_file.content` / `edit_file.edits[].old_string` 可能是
 *    整篇文章，原样下行就是流量事故（§7-⑦ 同一条纪律）。长度有硬上限，超长一律截断。
 *
 * 产出是**纯文本、纯函数**：同一份实现同时供真实电脑侧（`bridge/dto.ts`）与演示宿主
 * （`testing/mock-host.ts`）使用，两端不会漂移。
 *
 * 本模块承担工具调用的**两种呈现**（两级粒度，别混用）：
 * - {@link summarizeToolArgs} —— **折叠态**的一行摘要（硬上限 {@link TOOL_ARGS_MAX} = 160）；
 * - {@link formatToolArgs} —— **展开态**的完整入参（上限 {@link TOOL_DETAIL_MAX} = 5000，
 *   超出走中间省略 {@link elideMiddle}）。
 * 两级共用同一个 `shortenPath` 回调：同一份路径不能在折叠态与展开态显示成两个样子。
 */

/** 摘要长度硬上限：手机一行放不下更多，也避免长命令 / 长路径把帧撑大。 */
export const TOOL_ARGS_MAX = 160

/**
 * 各工具的「主参数」键名（按优先级），键名取自 `tool_defs/definitions.json`。
 *
 * 只列**需要与兜底顺序不同**的工具：其余工具（`file_info` / `vision_analyze` / `mkdir` …）
 * 的主参数就是 `path`，交给下面的通用规则即可。
 */
const PRIMARY_KEYS: Record<string, readonly string[]> = {
  read_file: ['path', 'paths'],
  delete_file: ['path', 'paths'],
  mkdir: ['path', 'paths'],
  execute_script: ['file_path'],
  search_knowledge_base: ['query'],
  list_knowledge_base_documents: ['knowledge_base_id'],
  get_knowledge_base_document: ['document_id', 'knowledge_base_id'],
  write_to_knowledge_base: ['document_name'],
  delete_knowledge_base_document: ['document_id', 'knowledge_base_id'],
  web_search: ['query'],
  web_fetch: ['url'],
  read_skill_source: ['name'],
  read_messages: ['message_id'],
  list_messages: ['keyword'],
  user_choice: ['question'],
}

/**
 * 兜底顺序 —— 未知工具（协议比工具集新 / 旧）也给出一个像样的摘要。
 *
 * `path` 在 `query` 之前：与桌面 `DefaultMessage` 的取舍一致（它也是优先取 `path`），
 * 这种「同一种入参键在两端必须是同一个含义」的规则不该各写一份。
 */
const FALLBACK_KEYS = [
  'command',
  'path',
  'paths',
  'file_path',
  'url',
  'query',
  'keyword',
  'name',
  'document_name',
  'document_id',
  'knowledge_base_id',
  'message_id',
  'question',
]

export interface ToolArgsSummaryOptions {
  /**
   * 路径缩短回调（电脑侧传 `toShortPath(path, workspace)`，与桌面卡片同一口径）。
   * 不传 = 原样显示 —— 演示宿主 / 单测不需要工作目录上下文。
   */
  shortenPath?: (path: string) => string
  /** 摘要上限，默认 {@link TOOL_ARGS_MAX}。 */
  maxLength?: number
}

/**
 * 生成一行入参摘要；没有可显示的内容时返回 `undefined`。
 *
 * 未知工具走兜底键序；一个都不命中时用「键=值」拼（最多两个键）——那是桌面
 * `DefaultMessage` 的行为，手机端不需要比它更聪明，但需要至少能看出「调了什么」。
 */
export function summarizeToolArgs(
  name: string,
  input: unknown,
  options: ToolArgsSummaryOptions = {},
): string | undefined {
  const max = options.maxLength ?? TOOL_ARGS_MAX
  // 入参可能是 JSON 字符串（引擎透传 / 老数据），先解开再当对象用
  const record = asRecord(input)
  if (!record) {
    /*
     * 看起来像 JSON 却解不开（老数据可能被截断）→ **不给摘要**：半截 JSON 不是信息，
     * 是噪音 —— 手机屏上一行「{ "path": "src/a」除了占地方什么也说明不了。
     */
    if (typeof input === 'string' && looksLikeJson(input)) return undefined
    const text = scalarText(input)
    return text ? clip(collapse(text), max) : undefined
  }

  const short = options.shortenPath ?? ((path: string) => path)
  const text = summarize(name, record, short)
  return text ? clip(collapse(text), max) : undefined
}

function summarize(
  name: string,
  rec: Record<string, unknown>,
  short: (path: string) => string,
): string | undefined {
  switch (name) {
    // 命令就是这件事本身（tips 是模型的解释，放不进行内摘要，留给桌面卡片）
    case 'execute_command':
      return scalarText(rec.command)

    case 'copy_move_file': {
      const source = pathText(rec.source, short)
      const dest = pathText(rec.destination, short)
      if (!source && !dest) return undefined
      if (source && dest) return `${source} → ${dest}`
      return source || dest
    }

    /*
     * 搜索类：桌面文案是「在 X 中搜索 Y」（`SearchTextInFileMessage` /
     * `SearchFileByNameMessage`），手机沿用同一句式 —— 用户在两个屏幕上看到同一句话，
     * 才不需要重新理解一次。
     */
    case 'search_text_in_files':
    case 'search_files_by_name': {
      const root = pathText(rec.path, short)
      const query = scalarText(rec.query)
      if (root && query) return `在 ${root} 中搜索 ${query}`
      return query ?? root
    }

    case 'read_file': {
      const paths = pathList(rec, short)
      if (!paths) return undefined
      const range = readRange(rec)
      return range ? `${paths} ${range}` : paths
    }

    case 'write_file': {
      const path = pathText(rec.path, short)
      if (!path) return undefined
      const lines = typeof rec.content === 'string' ? countLines(rec.content) : 0
      return lines > 0 ? `${path} · 写入 ${lines} 行` : path
    }

    case 'edit_file': {
      const path = pathText(rec.path, short)
      const stat = editStat(rec)
      if (!path) return stat
      return stat ? `${path} · ${stat}` : path
    }

    // 清单只在桌面的标题栏浮层里看；消息流这一行只需说明「改了流程」（桌面同一句文案）
    case 'todo_write': {
      const todos = rec.todos
      if (Array.isArray(todos)) return `更新了 ${todos.length} 项任务`
      return undefined
    }

    default:
      break
  }

  const keys = PRIMARY_KEYS[name] ?? FALLBACK_KEYS
  for (const key of keys) {
    const value = rec[key]
    if (Array.isArray(value)) {
      const list = listText(value, short)
      if (list) return list
      continue
    }
    const text = pathOrScalar(key, value, short)
    if (text) return text
  }

  return objectFallback(rec, short)
}

/** 一个键都不命中时的兜底：最多两个「键=值」，仍然比一整串 JSON 好读。 */
function objectFallback(
  rec: Record<string, unknown>,
  short: (path: string) => string,
): string | undefined {
  const parts: string[] = []
  for (const key of Object.keys(rec)) {
    if (parts.length >= 2) break
    const value = rec[key]
    if (Array.isArray(value)) continue
    const text = pathOrScalar(key, value, short)
    if (text) parts.push(`${key}=${text}`)
  }
  return parts.length ? parts.join(' ') : undefined
}

/** 路径类键名（这些键的值要过 `shortenPath`，其余原样）。 */
const PATH_KEYS = new Set(['path', 'paths', 'file_path', 'source', 'destination'])

function pathOrScalar(
  key: string,
  value: unknown,
  short: (path: string) => string,
): string | undefined {
  if (PATH_KEYS.has(key)) return pathText(value, short)
  return scalarText(value)
}

function pathText(value: unknown, short: (path: string) => string): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? short(trimmed) : undefined
}

/** 路径列表：首项 + `+N`（桌面也是一样只报首项与总数，不铺开一串）。 */
function listText(values: readonly unknown[], short: (path: string) => string): string | undefined {
  const items: string[] = []
  for (const value of values) {
    const text = pathText(value, short)
    if (text) items.push(text)
  }
  if (items.length === 0) return undefined
  if (items.length === 1) return items[0]
  return `${items[0]} +${items.length - 1}`
}

/** `path` / `paths` 两种形状统一成一行（批量形态优先：它是这次调用真正的覆盖面）。 */
function pathList(rec: Record<string, unknown>, short: (path: string) => string): string | undefined {
  if (Array.isArray(rec.paths)) {
    const text = listText(rec.paths, short)
    if (text) return text
  }
  return pathText(rec.path, short)
}

/** `read_file` 的读取范围：`start_line` / `max_lines` 都已知时给出行区间。 */
function readRange(rec: Record<string, unknown>): string | undefined {
  const start = numberText(rec.start_line)
  if (!start) return undefined
  const max = numberText(rec.max_lines)
  return max ? `${start}-${start + max - 1}` : `${start}`
}

/**
 * `edit_file` 的改动规模。
 *
 * 与桌面 `EditFileMessage` 的**降级分支**同一条算法（没有工具结果 uiData 时按入参行数估）：
 * 电脑侧手上只有入参，拿不到那次编辑的精确 diff —— 于是如实给一个「按行数估」的说法，
 * 文案与桌面逐字一致（`减少 X行,新增 Y行`）。
 */
function editStat(rec: Record<string, unknown>): string | undefined {
  let del = 0
  let ins = 0
  const edits = Array.isArray(rec.edits)
    ? rec.edits
    : [{ old_string: rec.old_string, new_string: rec.new_string }]
  for (const edit of edits) {
    const item = asRecord(edit)
    if (!item) continue
    if (typeof item.old_string === 'string') del += countLines(item.old_string)
    if (typeof item.new_string === 'string') ins += countLines(item.new_string)
  }
  const parts: string[] = []
  if (del > 0) parts.push(`减少 ${del}行`)
  if (ins > 0) parts.push(`新增 ${ins}行`)
  return parts.length ? parts.join(',') : undefined
}

/** 行数（末尾空行不算，与手机端 `countLines` 同一口径）。 */
function countLines(text: string): number {
  const body = text.replace(/\n+$/, '')
  return body.trim() ? body.split('\n').length : 0
}

/** 标量 → 文本：字符串 / 数字 / 布尔；其余（对象、数组、null）返回 `undefined`。 */
function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}

/** 数字键（`start_line` 之类）：只认正整数，`0` / 负数 / NaN 一律当没给。 */
function numberText(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined
}

/** 对象视图；JSON 字符串也认（宽松解析失败就返回 `undefined`，不抛）。 */
function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed.startsWith('{')) return undefined
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 看着像 JSON（对象 / 数组）：用于区分「一段普通文本」与「解不开的结构化入参」。 */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

/** 换行 / 连续空白压成单个空格：多行命令与 JSON 片段在行内摘要里必须是一行。 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// ─────────────────── 展开态的「完整入参」与通用中间省略 ───────────────────

/**
 * **展开区**文本的长度上限 —— 入参详情与工具输出**共用同一条线**。
 *
 * 与 {@link TOOL_ARGS_MAX} 不是一个量级，也不是一回事：那个是**折叠态一行**能放下多少字，
 * 这个是**展开后**愿意渲染多少字（用户 2026-10 拍板：超了就中间省略）。
 *
 * 为什么是 5000：手机一屏约 30 行 × 40 字，5000 字符已是四屏以上；再长就不叫「看」，
 * 叫「拖着滚」—— 而拖动过程中真正需要的信息（开头在做什么、结尾成没成）都在两头，
 * 中间那段从来没人读完过。
 */
export const TOOL_DETAIL_MAX = 5000

/**
 * 中间省略 —— 头尾都留，挖掉中间。
 *
 * 为什么不「从尾部截断」：工具输出与入参的**结论都在两头** —— 开头是命令 / 标题 / 第一个
 * 文件，结尾是报错 / 汇总 / 最后一个 diff 块。只留头等于把结论切掉，用户还得回电脑前看。
 *
 * ⚠️ 被省略的字符数写进正文里（`…（中间省略 N 字符）…`）——这是「这里少了东西」的
 * **唯一凭证**：只看长度看不出来，一段刚好的 5000 字符与被砍过的 5000 字符无法区分。
 */
export function elideMiddle(text: string, max: number = TOOL_DETAIL_MAX): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  // 标记本身也要占额度：先按最坏情况留出余量，末尾再兜一次硬截（结果绝不超上限）
  const keep = Math.max(2, max - MARKER_RESERVE)
  const headLength = Math.ceil(keep / 2)
  const head = text.slice(0, headLength)
  const tail = text.slice(text.length - (keep - headLength))
  const omitted = text.length - head.length - tail.length
  const result = `${head}\n\n${omittedMark(omitted)}\n\n${tail}`
  return result.length <= max ? result : result.slice(0, max)
}

/** {@link elideMiddle} 的最坏长度预留（标记行 + 首尾换行），用于算「还能留多少原文字符」。 */
const MARKER_RESERVE = 32

function omittedMark(omitted: number): string {
  return `…（中间省略 ${omitted} 字符）…`
}

/**
 * {@link formatToolArgs} 的可选项 —— 与 {@link ToolArgsSummaryOptions} 是同一种上下文。
 */
export interface ToolArgsFormatOptions {
  /**
   * 路径缩短回调（电脑侧传 `toShortPath(path, workspace)`）。
   *
   * ⚠️ 必须与 {@link summarizeToolArgs} 传的是**同一个**回调：折叠态显示 `src/a.ts`、
   * 展开后变成 `E:/code/demo/src/a.ts`，用户会以为点开卡片改坏了什么。
   */
  shortenPath?: (path: string) => string
  /** 上限，默认 {@link TOOL_DETAIL_MAX}（超出中间省略）。 */
  maxLength?: number
}

/**
 * 工具入参的**完整文本**（展开区用）：两空格缩进的 JSON，路径按工作目录缩短，超长中间省略。
 *
 * 为什么不把 {@link summarizeToolArgs} 的输出「加长」：摘要只挑**主参数**，而用户点开卡片
 * 想看的恰恰是那行没显示完的部分 —— 还有哪些键、`write_file` 到底写了什么、`edit_file` 的
 * old/new 是什么。唯一忠实的做法是把入参本身摆出来，于是这里与桌面导出
 * （`ui/pages/chat/components/sidebar` 的 `JSON.stringify(tc.input, null, 2)`）用同一种形态。
 *
 * ⚠️ 与摘要「只给摘要、不给原文」的纪律**不同**：这里允许出现正文（`write_file.content`
 * 会原样出现）—— 前提是用户**主动点开**才渲染，总量由 {@link TOOL_DETAIL_MAX} 兜住。
 * 折叠态绝不带它，那才是流量事故的现场。
 *
 * 没有可显示的内容 → `undefined`（展开区不渲染这一块）。
 */
export function formatToolArgs(
  input: unknown,
  options: ToolArgsFormatOptions = {},
): string | undefined {
  const max = options.maxLength ?? TOOL_DETAIL_MAX
  const short = options.shortenPath ?? ((path: string) => path)
  const value = normalizeDetail(input)
  if (value === undefined || isEmptyDetail(value)) return undefined
  const text =
    typeof value === 'object'
      ? JSON.stringify(shortenPathValues(value, short), null, 2)
      : String(value)
  const trimmed = (text ?? '').trim()
  return trimmed ? elideMiddle(trimmed, max) : undefined
}

/**
 * 归一化入参：JSON 字符串解开、普通文本原样、标量转文本，对象 / 数组原样。
 *
 * 解不开的 JSON 字符串**原样给出**（与摘要那边的取舍相反：摘要是「半截 JSON 不是信息」，
 * 而展开区是用户点开来看的现场 —— 模型真发了一段坏 JSON，如实摆出来比藏起来有用）。
 */
function normalizeDetail(input: unknown): unknown {
  if (input === undefined || input === null) return undefined
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return undefined
    if (!looksLikeJson(trimmed)) return trimmed
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed
    }
  }
  if (typeof input === 'object') return input
  return scalarText(input)
}

/**
 * 空入参（`{}` / `[]`）→ 没有可展示的内容。
 *
 * 为什么不是把它当「入参为空」显示出来：展开区那一块的唯一职责是回答「刚才调它的时候
 * 到底传了什么」。无参数的工具（`get_current_time` 之类）传了个空对象 —— 摆一个 `{}`
 * 只占地方，反而让用户以为漏显示了什么。
 */
function isEmptyDetail(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  if (value && typeof value === 'object') return Object.keys(value as object).length === 0
  return false
}

/**
 * 递归把**路径键**的值缩短（键名与 {@link PATH_KEYS} 同一份：`path` / `paths` / `file_path` …）。
 */
function shortenPathValues(value: unknown, short: (path: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => shortenPathValues(item, short))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = PATH_KEYS.has(key) ? shortenPathValue(raw, short) : shortenPathValues(raw, short)
  }
  return out
}

/** 路径键的值：字符串 / 字符串数组缩短，其余按普通值递归。 */
function shortenPathValue(value: unknown, short: (path: string) => string): unknown {
  if (typeof value === 'string') return short(value)
  if (Array.isArray(value)) return value.map((item) => shortenPathValue(item, short))
  return shortenPathValues(value, short)
}
