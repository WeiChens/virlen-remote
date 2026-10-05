/**
 * 类型化 API 定义 + 两端共用的推导辅助（见 docs/phone-control-bridge.md §2.2/§2.3）。
 *
 * **命名法：按「谁实现」命名，而不是「谁调用」。**
 * - `host.*`   = 电脑实现、手机调用
 * - `mobile.*` = 手机实现、电脑调用
 * 这样同一份定义能被两端共用：手机侧推导出类型安全客户端，电脑侧推导出必须实现的 handler 签名。
 * **改一处，两端同时编译报错。**
 *
 * ⚠️ 本文件当前承载「协议表」；DTO 为白名单投影（§7-⑥：绝不 `{...session}`），
 * 具体从电脑侧 store 投影到 DTO 的适配在 M2 的 `dto.ts` 落地。
 */
import type { CallContext, Endpoint } from './endpoint'
import type { MessageQuote } from './message-actions'

// ───────────────────────────── DTO（白名单投影） ─────────────────────────────

export interface SessionSummaryDTO {
  id: string
  title: string
  updatedAt: number
  /** 该会话是否正在跑 run（手机据此显示「工作中」）。 */
  working?: boolean
  /** 是否置顶（M4：手机可置顶/取消置顶，需要知道当前态——目标态语义，不能靠切换）。 */
  pinned?: boolean
  // ── 会话列表分组 / 信息面板（§22）──
  /** 归属 Agent id（抽屉「按 Agent 分组」的依据）。 */
  agentId?: string
  /** 归属 Agent 显示名（电脑侧解析，手机不查表）。 */
  agentName?: string
  /**
   * 工作目录（**归一化绝对路径**，`/` 分隔）。
   *
   * ⚠️ 这是 §22 对 §7-⑥ 的**有意放宽**：手机端要按工作目录分组、并在**新建会话时**选目录，
   * 必须能看到它。越权防线不在「手机看不到路径」，而在**电脑侧的候选集校验**
   * （`host.session.create` 只接受 `host.workspace.list` 给过的目录，见 §22.3）。
   * 仍然不外发 `systemPrompt` / `params` / `allowedTools`（那些才是真正的泄露面）。
   */
  workspace?: string
  // ── 当前模型（信息面板展示；切换见 `host.session.setModel`）──
  providerConfigId?: string
  providerName?: string
  modelId?: string
}

export interface MessageDTO {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  /**
   * 纯文本投影；图片等富内容一期剥离为占位符（§7-⑦）。空串 = 无正文（手机端不渲染空气泡）。
   *
   * ⚠️ 空串有**两种**来源，靠 `detail` 区分：本来就没有正文，与**正文被传输档位省略**
   * （中继 / 类型未知时工具输出不下发，见共享包的 `TransferTier`）。把后者当成前者，
   * 就是给用户写一句不成立的结论。
   *
   * ⚠️ **引用块不在本字段里**（见 `quotes`）：引用是结构化下行的，若同时把它展平进
   * `text`，消费方就会把同一段引文显示两遍（引用条 + 正文里的 `[引用] …`）。
   *
   * ⚠️ **工具输出（`role:'tool'`）有长度上限**：超过 `TOOL_DETAIL_MAX`（5000）字符时
   * 电脑侧会做**中间省略**（`elideMiddle`），并把 `…（中间省略 N 字符）…` 写在正文里 ——
   * 头尾都是真的，只少了中间那段。所以它**不是**「正文被篡改」，消费方不得据此
   * 提示「内容不可信」；要判「有没有被砍过」就看那一行标记（长度看不出来）。
   */
  text: string
  createdAt: number
  /**
   * 正文完整性标记（**可选**，只在正文被有意省略时出现）。
   *
   * `'omitted'`：`text` 为空是**档位决定**，不是「这次调用没有输出」—— 工具输出确实存在，
   * 只是这条链路（TURN 中继 / 类型未知）按精简档不下发（§33）。手机端据此显示「输出已省略」。
   *
   * ⚠️ 消费方**不要穷举取值**：判「有没有这个字段」，不认识的值一律按「正文不完整」处理 ——
   * 将来增加别的完整性档（如截断）时，旧消费方仍应给出诚实的提示而不是当成完整正文。
   */
  detail?: 'omitted'
  /**
   * 工具名（仅 `role:'tool'`，如 `read_file`）。
   *
   * 来源：电脑侧用 `toolCallId` 反查发起该调用的 assistant 消息的 `toolCalls[].name`
   * （与桌面 `message-list/helpers.ts::resolveJumpAnchorId` 同一套匹配规则）。
   * 手机端**不猜**：拿不到就只显示「工具」。
   */
  toolName?: string
  /**
   * 工具**入参摘要**（仅 `role:'tool'`；一行纯文本，如 `src/store/chat.ts`、
   * `npm run build`、`在 src 中搜索 sessionError`）。
   *
   * 为什么需要一个字段：工具气泡只说「调了 read_file」，用户并不知道**看的是哪个文件**；
   * 桌面端这条信息来自 `toolCalls[].input`（28 个 `getShortText()` 组件各挑各的主参数）。
   * 手机是第二个屏幕，同样需要「这一步在干什么」。
   *
   * ⚠️ **不是原始入参**：`write_file.content` / `edit_file.edits[].old_string` 可能是整篇文章，
   * 原样下行就是流量事故（§7-⑦）。电脑侧只挑关键入参、格式化并截断
   * （`summarizeToolArgs`，与演示宿主共用同一份实现）。
   *
   * 消费方注意：拿不到（旧电脑端 / 跨页工具调用）时字段缺席 ——
   * 此时**只显示工具名**，不要猜、也不要用正文反推。
   */
  toolArgs?: string
  /**
   * 工具**入参详情**（仅 `role:'tool'`；多行，展开工具卡片后才渲染）。
   *
   * 为什么与 `toolArgs` 并存：那一行摘要只挑**主参数**（且硬上限 160 字符），真机反馈是
   * 「入参显示不完整」—— 用户点开卡片想知道「刚才那行没显示完的是什么」。这里是入参本身
   * （两空格缩进的 JSON，与桌面导出的同一种形态），路径与 `toolArgs` 走**同一个**缩短回调。
   *
   * ⚠️ **它比 `toolArgs` 重得多**（`write_file.content` 会原样出现，只是被 `TOOL_DETAIL_MAX`
   * 兜住），所以纪律也反了一面：`toolArgs` 是「只给摘要、不给原文」，这里是「用户主动点开
   * 才渲染的现场」。消费方**不得**把它放进折叠态（那会把流量事故从电脑搬到手机屏幕上）。
   *
   * 超长时同样是**中间省略**（标记行写在正文里）。字段缺席 = 没有可显示的入参
   * （旧电脑端 / 跨页工具调用 / 入参为空）→ 展开区不渲染这一块，不要凭空造。
   */
  toolArgsFull?: string
  /**
   * 本条消息引用了哪些历史消息（快照，**可选**；只有带引用的用户消息才有）。
   *
   * 为什么结构化下行而不展平进 `text`：桌面端把它渲染成气泡上方的引用条（`QuoteChip`），
   * 并可点击跳回原消息 —— 展平成一串文本就再也拆不回来了（`[引用] …` 只是个前缀，
   * 正文里本来就可能有同样的字样）。
   *
   * 消费方注意：`quotes[].text` 是**快照**，可能很长（引用一整段 AI 回答）—— 引用条应**截断显示**，
   * 发给模型的是完整快照（与桌面一致，不要在协议层擅自裁剪用户要引用的内容）。
   */
  quotes?: MessageQuote[]
}

export interface RuntimeDTO {
  working: boolean
  paused?: boolean
  error?: string
  /** 是否正在压缩上下文（压缩是长任务，手机据此显示进度）。 */
  compacting?: boolean
  /**
   * 正在生成的工具调用进度（引擎在**累积工具参数**期间推送）。
   *
   * 为什么需要：provider 在累积参数 JSON 期间不发任何事件（见 `docs/phone-control-bridge.md`
   * §27），长参数（如 `write_file` 写一篇文章）意味着数秒到数十秒内上层看不到任何变化 ——
   * 这个字段让界面能显示「正在写入 write_file · 1.2k 字符…」，而不是看起来卡死。
   *
   * 只带工具名与已累积字符数，**不含参数内容**（带宽 / 隐私 / 界面也不需要）。
   */
  toolProgress?: { name: string; chars: number } | null
  /**
   * **正在执行中**的工具调用（引擎**已开始执行、结果还没回来**的那几个）。
   *
   * 为什么需要（`toolProgress` 管不到这一段）：`toolProgress` 只在**累积参数**期间有值，
   * 一旦工具开始执行就被清掉（那时的判据是「参数生成完了」）—— 于是从「开始执行」到
   * 「结果消息到达」之间，电脑侧界面上有一张**呼吸点卡片**（桌面上由
   * `message-bubble.tsx` 用「assistant 的 `toolCalls[]` 减去已有结果」推导出来），
   * 而手机端此前**一点都看不到**：工具消息只在**执行完之后**才作为消息下行，
   * 这段静默期手机上只剩「正在思考…」，看起来像卡死（真机反馈）。
   *
   * 语义（电脑侧权威，与桌面 pending 卡片**同一判据**）：已声明、尚无同 `toolCallId`
   * 结果消息的那些调用；仅 `working === true` 时可能有值，字段缺席 = 此刻没有执行中的工具。
   *
   * ⚠️ **不要把它当成「进度」来理解**：这里没有百分比、没有输出。`args` 是一行**摘要**
   * （与 `MessageDTO.toolArgs` 同一格式化口径），**绝不含参数正文** —— 工具的执行输出走
   * 结果消息（`role:'tool'`），运行中的实时输出目前不下行。
   */
  runningTools?: RunningToolDTO[]
}

/** `RuntimeDTO.runningTools` 的一条：正在执行的一次工具调用。 */
export interface RunningToolDTO {
  /**
   * 本次调用的 id（与结果消息 `MessageDTO.toolCallId` 同一个 id）。
   *
   * 消费方可用它把「执行中」与「已到达的结果」对齐（例如结果到达后收掉那一行）；
   * 只按顺序对齐是不行的 —— 同一批可能有多个调用并行执行。
   */
  toolCallId: string
  /** 工具名（如 `read_file`）—— 手机端「这一步在干什么」的主语。 */
  name: string
  /**
   * 入参**一行摘要**（与 `MessageDTO.toolArgs` 同一条格式化口径、同一个长度上限）。
   *
   * 拿不到主参数时字段缺席（旧电脑端不会发这个字段；新电脑端给不出摘要时也不发）——
   * 此时只显示工具名，**不要用别的字段反推**。
   */
  args?: string
}

/**
 * 授权分级（M4，见 docs/phone-control-bridge.md §16.2）。
 *
 * **分级只决定「手机批准前是否需二次确认」，不决定「谁能批」**（宽松档下手机可批全部）。
 * 判定在电脑侧（`virlen-app/src/bridge/approval-policy.ts`），手机只消费结果。
 */
export type ApprovalTier = 'low' | 'high'

/**
 * 一次待应答交互的完整投影（手机端据此渲染卡片）。
 *
 * ⚠️ **电脑侧的 `interactionId` 是唯一权威标识**：手机应答时必须原样回传，
 * 电脑侧按 id 精确路由（见 `events/toolInteractEvent.ts` 文件头）。
 */
export interface InteractionDTO {
  interactionId: string
  /**
   * 归属会话。
   * **空字符串 = 会话未知** —— 终端内确认（`presentation:'terminal'`）的 `PendingConfirmInfo`
   * 不带会话信息，手机端以「全局卡片」呈现（§16.4）。
   */
  sessionId: string
  toolCallId?: string
  kind: 'choice' | 'authorization'
  createdAt: number
  /** 风险分级：`high` 时手机必须先展开原文 + 勾选确认，并在应答时带 `confirmed:true`。 */
  tier: ApprovalTier
  // ── kind='choice'（AI 提问，非安全边界）──
  question?: string
  options?: string[]
  multi?: boolean
  // ── kind='authorization' ──
  /** 权限唯一 key（跨 TS / Rust 稳定契约），如 `terminal.normal.execute` */
  permName?: string
  title?: string
  subTitle?: string
  /** 正文：命令文本 / 脚本正文 */
  desc?: string
  /** 实际执行命令（当 `desc` 不是命令本身时提供，如脚本正文） */
  command?: string
  hint?: string
  /** 风险等级（`safe` / `install` / `dangerous`，与 `classify.rs` 对齐） */
  risk?: string
  /** AI 申请不使用沙盒 */
  sandboxBypass?: boolean
  /**
   * 呈现方式：
   * - `modal`：桌面弹窗授权（默认）
   * - `terminal`：**终端内确认** —— 手机只能「原样放行」或「拒绝」，**不能编辑命令**（§16.4）
   */
  presentation?: 'modal' | 'terminal'
}

/**
 * 一次交互的终态。
 *
 * 与电脑侧 `toolInteractEvent` 的 `InteractionOutcome`（`allow|reject|shelve`）**语义对齐但命名不同**：
 * 线上统一用 `deny`（对手机而言「拒绝」比「reject」更一致），另加 `expired`（电脑侧已不再挂起）。
 */
export type InteractionOutcome = 'allow' | 'deny' | 'shelve' | 'expired'

/**
 * 流式正文的发送方式（见 `host.event.message.stream`）。
 *
 * - `full`：每帧发**整段正文** —— 实现简单，但一条 n 字的消息会传 O(n²) 字节；
 * - `delta`：一帧只发**新增后缀**（配 `offset` 对齐）—— O(n)。
 *
 * **由客户端在 `hello` 里声明偏好**（`HelloParams.streamMode`），服务端不猜：
 * 没声明就按 `full` 发，否则旧客户端会把一帧增量当成全文渲染（正文错位）。
 */
export type StreamMode = 'full' | 'delta'

// ───────────────────────────── 方法表 ─────────────────────────────

export interface SendParams {
  sessionId: string
  text: string
  /**
   * 引用若干条历史消息（可选）。
   *
   * 电脑端把它组装成 `{type:'quote'}` 内容块（与桌面输入框的引用附件走**同一个**
   * `buildUserContent`），因此下游（引擎 / 持久化 / 桌面渲染 / 导出）的语义与桌面完全一致：
   * 模型看到的是结构化的引用块，桌面端显示引用条并可点击跳回原消息，引文是**快照**
   * （原消息被删 / 被压缩也不影响）。
   *
   * ⚠️ **只在电脑端声明 `MESSAGE_QUOTE_CAPABILITY` 时才能发**：旧电脑端不认这个参数，
   * RPC 会「成功」而引文被静默丢掉（用户会以为引用了，AI 却当没看见）。
   * 另外这是 `session.send` 的一个参数，**不是新权限** —— 越权防线仍是 `session.send`。
   */
  quotes?: MessageQuote[]
}

export interface MsgPageParams {
  sessionId: string
  /**
   * 更早一页的游标（M5）—— 原样回传上一次应答的 `MsgPageDTO.cursor`。
   *
   * ⚠️ 不传 = 取**尾部窗口**；传了 = 取该游标之前的一页。
   * 不要把 `undefined` 与 `null` 混淆：电脑侧判据是 `!= null`。
   */
  fromRowid?: number
  /**
   * 每页条数。
   *
   * ⚠️ **电脑侧实现目前忽略本字段**：分页窗口由电脑侧的加载窗口
   * （`MESSAGE_PAGE_SIZE` = 60）决定 —— 展示窗口必须 ≡ 已加载窗口，否则游标会指向
   * 窗口**之外**的消息，续页时漏掉中间消息（见 §20.2-A）。预留给二期（届时需同步调整游标语义）。
   */
  limit?: number
}

export interface MsgPageDTO {
  messages: MessageDTO[]
  hasMore: boolean
  /**
   * 下一页（更早）游标（M5）。
   *
   * **不透明**：手机端原样回传给 `MsgPageParams.fromRowid` 即可，**不要解析其数值语义**
   * （电脑侧实现是 rowid，但那是实现细节）。
   * `hasMore=false` 时为 `null`。
   */
  cursor?: number | null
}

export interface AnswerParams {
  interactionId: string
  action: AnswerAction
  /**
   * `action='choose'` 时的选择结果：`{ selected?: string[]; customReply?: string }`。
   * 电脑侧会按与桌面 UI **完全相同的形态**构造给引擎的 `ToolResult`（含 `uiData`）。
   */
  value?: unknown
  /**
   * 高风险（`tier='high'`）的**批准**必须为 `true`。
   * ⚠️ 电脑侧**独立校验**：手机 UI 漏改不算数（缺则 `E_CONFIRM_REQUIRED`）—— §16.2。
   */
  confirmed?: boolean
}

/** 手机一次应答的四种动作。 */
export type AnswerAction = 'allow' | 'deny' | 'shelve' | 'choose'

// ── §22：模型 / 工作目录 / 上下文（手机端可看可切的部分）──

/**
 * 「100%」对应的上下文窗口默认值（电脑侧设置里可改；CLI 读同一份设置）。
 *
 * 放在协议层是因为**两端要用同一个数**：电脑侧算 `ContextInfoDTO.windowTokens`，
 * 手机侧算占用比例，mock 宿主也用它。各端各写一份必然会分叉。
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000

/**
 * 压缩上下文的最小占用比例。
 *
 * 低于它：桌面 token 环只提示「无需压缩」，电脑侧 `host.session.compress` 直接拒
 * （`E_BAD_REQUEST`），手机端也不显示压缩按钮 —— **同一条判据，不许两端各写一份**
 * （§18.5 的教训：口径写两份的那次是「给 AI 的文案」）。
 */
export const COMPRESS_MIN_RATIO = 0.4

/**
 * 一个**已启用**的模型服务及其可选模型（`host.model.list`）。
 *
 * 白名单投影：只给 `id` / `name` / `models` —— **不含** `apiKey` / `baseUrl` / `params`
 * （那些是电脑侧的机密与本地配置，§7-⑥）。
 */
export interface ModelProviderDTO {
  id: string
  name: string
  models: string[]
}

/**
 * 新建会话可选的工作目录（`host.workspace.list`）。
 *
 * ⚠️ **候选集由电脑侧给出，手机不得自造**（「不能让手机端创建没有过的目录」）。
 * 电脑侧从既有数据里收集：各会话的 `workspace` + 各 Agent 的 `defaultWorkspace` + 全局默认工作目录。
 * `host.session.create` 会**独立校验**回传的 `workspace` 是否属于该集合（§22.3）。
 */
export interface WorkspaceOptionDTO {
  /** 归一化绝对路径（`/` 分隔）；也是 `host.session.create` 回传的值。 */
  path: string
  /** 末级目录名（电脑侧算好，避免两端各写一份路径解析）。 */
  name: string
  /** 使用该目录的既有会话数（展示用）。 */
  sessionCount: number
}

/**
 * 新建会话可选的 Agent（`host.agent.list`）。
 *
 * 白名单投影：只给 `id` / `name` / 默认模型 / 默认工作目录 —— **不含** `systemPrompt`
 * （可达数十 KB）、`allowTools` / `skills` / `params`（本地配置，§7-⑥）。
 *
 * 默认值**只用于展示**（让手机端把「选它会发生什么」说清楚，并在切换 Agent 时联动显示）；
 * 真正的会话组装仍在电脑侧 `createSession` 里做 —— 手机端传不传模型 / 目录都不影响结果。
 */
export interface AgentOptionDTO {
  id: string
  /** Agent 显示名（电脑侧已解析，手机不查表）。 */
  name: string
  /** Agent 的默认模型；未配置则缺省（不显示）。 */
  defaultModel?: { providerConfigId: string; modelId: string }
  /** Agent 的默认工作目录（归一化绝对路径）；未配置则缺省。 */
  defaultWorkspace?: string
}

/**
 * 上下文占用（`host.session.context` / `host.event.session.context.changed`）。
 *
 * 口径与桌面 token 环**完全一致**（`domain/usage/context-occupancy.ts`，单一真源）：
 * 取最后一条带 `uiData.contextTokens`（压缩产物）或 `usage.totalTokens` 的消息。
 */
export interface ContextInfoDTO {
  /** 当前上下文占用（token）；无法判定（消息未加载 / 无用量）时为 `null`。 */
  tokens: number | null
  /** 「100%」对应的上下文窗口大小（来自电脑侧设置，CLI 读同一份）。 */
  windowTokens: number
}

export interface SetModelParams {
  sessionId: string
  providerConfigId: string
  modelId: string
}

export interface ContextParams {
  sessionId: string
}

export interface CompressParams {
  sessionId: string
  /**
   * 必须为 `true`。
   *
   * 压缩会**用摘要替换整段历史**（不可逆，与删除会话同档）——§16.3-3 要求手机端二次确认，
   * 电脑侧独立校验，缺则 `E_CONFIRM_REQUIRED`。
   */
  confirm: true
}

/** 交互已被处理 / 手机应答被拒的原因（UI 据此提示，不弹错误）。 */
export type AnswerRejectReason =
  | 'not-found'
  | 'already-settled'
  | 'confirm-required'
  | 'invalid-value'
  | 'unsupported-by-host'

export interface AnswerResult {
  accepted: boolean
  reason?: AnswerRejectReason
}

// ── M4 写操作参数 ──

export interface CreateSessionParams {
  /** 不传则用电脑端的默认命名 */
  title?: string
  /**
   * 工作目录（**必须来自 `host.workspace.list`**；电脑侧独立校验，越权即 `E_BAD_REQUEST`）。
   *
   * 不传 = 沿用 Agent 的 `defaultWorkspace`（电脑侧行为）。
   */
  workspace?: string
  /**
   * 模型服务与模型 id；不传 = 沿用**所选 Agent** 的默认模型（未选 Agent 即默认 Agent 的）。
   */
  providerConfigId?: string
  modelId?: string
  /**
   * 归属 Agent（**必须来自 `host.agent.list`**；电脑侧独立校验，未知 id 即 `E_BAD_REQUEST`）。
   *
   * 不传 = 电脑侧的默认 Agent（与桌面「直接新建」的同构行为）。归属 Agent 决定
   * systemPrompt / 工具白名单 / skills / 默认参数，因此电脑侧接受这条字段受
   * `session.agent` 权限约束（见 `SESSION_AGENT_CAPABILITY`）。
   */
  agentId?: string
}

export interface RenameSessionParams {
  sessionId: string
  title: string
}

export interface PinSessionParams {
  sessionId: string
  pinned: boolean
}

export interface DeleteSessionParams {
  sessionId: string
  /**
   * 必须为 `true`。会话删除不可逆（消息级联删除）—— §16.3-3 要求手机端二次确认，
   * 电脑侧独立校验，缺则 `E_CONFIRM_REQUIRED`。
   */
  confirm: true
}

/**
 * 删除单条消息**及其之后的全部消息**（截断）—— 与桌面右键菜单的「删除」同一条路径
 * （`deleteSessionMessage`），**不是**「把这一条从中间抽走」。
 *
 * 为什么是截断而不是单删：一条消息的历史是**因果链** —— 抽走中间一条用户提问，
 * 后面 AI 的回答就失去了提问；抽走一条带 `tool_calls` 的 assistant 消息，后面的
 * 工具结果就成了孤儿（引擎侧要额外做悬空修补）。桌面端已经用「本条及后续」表达了这个
 * 事实，手机端**不得**另立一套更「温和」的语义 —— 那只会让两个入口对同一次操作给出
 * 不同的后果（用户删了中间一条，电脑上的历史却不一样）。
 *
 * 角色限制：`role:'tool'` 的消息**不可删**（工具结果与发起它的 assistant 消息是一体两面，
 * 单独删掉只会留下悬空调用）—— 电脑侧拒绝，手机端也不提供入口。
 */
export interface DeleteMessageParams {
  sessionId: string
  messageId: string
  /**
   * 必须为 `true`。截断不可逆 —— §16.3-3 要求手机端二次确认，电脑侧独立校验，
   * 缺则 `E_CONFIRM_REQUIRED`（手机端 UI 的确认弹窗不算数）。
   */
  confirm: true
}

/** 电脑实现、手机调用。 */
export interface HostApi {
  'host.hello': { params: import('./hello').HelloParams; result: import('./hello').HelloResult }
  'host.session.list': { params: Record<string, never>; result: { sessions: SessionSummaryDTO[] } }
  'host.session.messages': { params: MsgPageParams; result: MsgPageDTO }
  /** delta 模式对齐用（§3.6）：跳号时拉全文。 */
  'host.session.message.get': { params: { sessionId: string; messageId: string }; result: { message: MessageDTO } }
  'host.session.send': { params: SendParams; result: { messageId: string } }
  'host.session.cancel': { params: { sessionId: string }; result: { ok: true } }
  /**
   * 从暂停的 run 快照恢复执行（M5，与手机端「暂存」配对）。
   *
   * 电脑侧落点为唯一恢复入口 `resumePausedRun`；会话未处于暂停态时电脑侧报 `E_BAD_REQUEST`。
   */
  'host.session.resume': { params: { sessionId: string }; result: { ok: true } }
  'host.session.subscribe': { params: { sessionId: string; fromRowid?: number }; result: { ok: true } }
  // ── M4 写操作（§16.1）──
  'host.session.create': { params: CreateSessionParams; result: { sessionId: string } }
  'host.session.rename': { params: RenameSessionParams; result: { ok: true } }
  'host.session.pin': { params: PinSessionParams; result: { ok: true } }
  /** ⚠️ 不可逆：必须带 `confirm: true`（缺则 `E_CONFIRM_REQUIRED`）。 */
  'host.session.delete': { params: DeleteSessionParams; result: { ok: true } }
  /**
   * 删除单条消息及其之后的全部消息（截断，不可逆）。
   *
   * 与 `host.session.message.get` 同属「消息级」方法。结果**不**在本应答里回传快照：
   * 电脑侧会推 `host.event.session.messages.reset`，手机端据此重拉窗口（§3.5 的同一策略——
   * 不发明增量协议，让「重拉快照」这个天然幂等的动作承担一致性）。
   *
   * 电脑侧还会拦两种情况：会话正在回复（`E_BUSY`，与 `send` / `compress` 同一条并发纪律）、
   * 目标是 `role:'tool'` 的消息（`E_BAD_REQUEST`）。
   */
  'host.session.message.delete': { params: DeleteMessageParams; result: { ok: true } }
  'host.interaction.answer': { params: AnswerParams; result: AnswerResult }
  /**
   * 当前待应答交互（**拉取式**，M4）。
   *
   * 为什么必需：`host.event.interaction.requested` 是**一次性事件** ——
   * 手机在交互发起之后才连上/重连时，事件已错过，它只看到「会话卡在 working」而不知为何。
   * 手机在每次链路就绪后拉一次本方法，即可补齐（权威源是电脑侧注册表）。
   */
  'host.interaction.list': { params: Record<string, never>; result: { interactions: InteractionDTO[] } }
  // ── §22：模型 / 工作目录 / 上下文 ──
  /** 已启用的模型服务与模型（手机端模型选择器）。 */
  'host.model.list': { params: Record<string, never>; result: { providers: ModelProviderDTO[] } }
  /**
   * 切换会话使用的模型（**对已有会话**；桌面 model-switcher 的等价操作）。
   *
   * 与桌面同构：不刷新 `updatedAt`（会话时间只由用户发消息刷新），下一轮生效。
   */
  'host.session.setModel': { params: SetModelParams; result: { ok: true } }
  /**
   * 新建会话可选的 Agent 候选集（手机端 Agent 选择器）。
   *
   * 与 `host.model.list` / `host.workspace.list` 同族，同样**只用于新建会话**：
   * 已有会话的 Agent 不可改 —— 换了 Agent 就是换 systemPrompt / 工具白名单 / skills，
   * 历史对话会前后错配（与工作目录不可改同一条理由，§22.3）。
   */
  'host.agent.list': { params: Record<string, never>; result: { agents: AgentOptionDTO[] } }
  /**
   * 新建会话可选的工作目录候选集。
   *
   * ⚠️ 只用于**新建会话**；已有会话的工作目录不可改（用户 2026-09-28 拍板，§22.3）。
   */
  'host.workspace.list': { params: Record<string, never>; result: { workspaces: WorkspaceOptionDTO[] } }
  /** 上下文占用快照（拉取式，配合 `host.event.session.context.changed` 增量）。 */
  'host.session.context': { params: ContextParams; result: ContextInfoDTO }
  /**
   * 压缩上下文（用摘要替换历史）。
   *
   * fire-and-forget：RPC 只回投递确认 —— 进度走 `runtime.compacting`，结果走
   * `host.event.session.messages.reset`（手机重拉窗口）+ `message.added`（摘要消息）。
   * ⚠️ 必须带 `confirm: true`；上下文充裕（低于 40%）时电脑侧直接拒（与桌面 token 环同判据）。
   */
  'host.session.compress': { params: CompressParams; result: { ok: true } }
}

/** 手机实现、电脑调用。 */
export interface MobileApi {
  'mobile.ping': { params: Record<string, never>; result: { ts: number } }
}

// ───────────────────────────── 事件表 ─────────────────────────────

export interface HostEvents {
  'host.event.session.list.changed': { sessions: SessionSummaryDTO[] }
  /** 已定稿消息的变化 —— 完整对象，天然幂等。 */
  'host.event.message.added': { sessionId: string; message: MessageDTO }
  'host.event.message.updated': { sessionId: string; message: MessageDTO }
  /**
   * 「正在生成中的那一条消息」的流式同步 —— 与 message.* 分离的独立通道。
   *
   * **一期发 `mode='full'`（每帧整段），二期（2026-09-30，§32）起支持 `mode='delta'`。**
   * 带宽差一个量级：一条 n 字的消息，整帧发是 O(n²) 字节（每帧都把已有全文再传一遍），
   * 增量发是 O(n)。真机上「长回复越到后面越卡」的观感就来自前者。
   */
  'host.event.message.stream': {
    sessionId: string
    messageId: string
    /** 同一 `messageId` 内递增，从 1 开始；换消息重新从 1 算。 */
    seq: number
    /**
     * `full` = `text` 是整段正文（客户端直接替换）；
     * `delta` = `text` 只是新增后缀（客户端按 `offset` 追加）。
     *
     * 什么时候是 `full`（三个时机，客户端不能假定「只有首帧是 full」）：
     *   1. 该消息的**首帧**（客户端没有任何基准）；
     *   2. 正文**被改写**（新正文不是旧正文的前缀，如定稿回填 / 修复）；
     *   3. `final=true` 的收尾帧（定稿全文）。
     */
    mode: StreamMode
    text: string
    /**
     * 仅 `mode='delta'`：本段 `text` 在整段正文中的**起始偏移**（= 发送前已发出的长度）。
     *
     * 为什么必须有它：客户端手上有多少正文**只有它自己知道** —— 中途订阅、
     * `messages.reset` 后重拉、断线重连都会让它落后于服务端的发送基准。有了偏移，客户端能：
     *   - 把**完全重复**的段丢掉（`offset + text.length ≤ 本地长度`）；
     *   - 把**部分重叠**的段按尾巴补上（本地长度 − `offset` 之后的那些字符）；
     *   - 在**真缺一段**时（`offset > 本地长度`）发现缺口，调 `host.session.message.get` 拉全文对齐。
     * 没有它就只能靠 seq 连续性猜，而猜错是**静默的正文错位**（比丢帧难查得多）。
     */
    offset?: number
    /** 收尾帧：`text` 为定稿全文（客户端渲染最终版本以随后的 `message.added` 为准）。 */
    final: boolean
  }
  'host.event.session.runtime.changed': { sessionId: string; runtime: RuntimeDTO }
  'host.event.interaction.requested': { interaction: InteractionDTO }
  'host.event.interaction.resolved': {
    interactionId: string
    by: 'host' | 'mobile'
    /** 终态；`expired` = 电脑侧已不再挂起该交互（如会话被取消） */
    outcome?: InteractionOutcome
  }
  /**
   * 上下文占用变化（§22）。
   *
   * 与 `interaction.requested` 同样是「增量 + 快照」组合里的增量：快照是
   * `host.session.context`。只推**已订阅**会话（与消息推送同一订阅集合）。
   */
  'host.event.session.context.changed': { sessionId: string; context: ContextInfoDTO }
  /**
   * 该会话的消息**被整体替换或删除**（压缩 / 删消息），本地增删 diff 已无法表达。
   *
   * 语义：手机**丢弃**该会话缓存的消息窗口并重拉（`host.session.messages`），
   * 而不是逐条对账 —— 压缩会把整段历史换成一条 summary，逐条 diff 只会得到一份错位的历史。
   * 为什么必需：此前删除的消息只是从电脑侧快照里消失（不发事件），手机端会一直显示幽灵消息。
   */
  'host.event.session.messages.reset': { sessionId: string }
  /**
   * 本机（电脑）视角的链路通讯类型 —— 「这次连接到底是直连还是走了 TURN 中继」。
   *
   * 同一事实在本端也成立（手机端同样有一条所选候选对，可自行判定），本事件的用途是让手机
   * **拿电脑视角交叉校验**：两端口径已收敛到共享包的 `classifyLinkKind`（见 `HostEvents` 之外
   * 的 `virlen-remote` 导出），若仍不一致，说明有一端的 stats 读取出了问题。
   *
   * 只在结论**确定**（`direct` / `relay`）时发送：链路刚建立 / 正在重协商时电脑端算不出结论，
   * 那属于「没有结论」，**不发事件**（而不是发一个猜测）；`unknown` 不在本事件的取值域内。
   */
  'host.event.connection.changed': {
    path: 'direct' | 'relay'
    /**
     * ⚠️ **预留字段，当前不发送**（`virlen-remote@0.1.2` 起转为可选）。
     *
     * 语义（若将来启用）：链路虽可用但已**降级**（例如被迫走中继、或质量明显下滑）。
     * 当前实现只区分 `path`，没有任何独立可观测的「降级」判据，故先留空 —— 与其用一个尚未
     * 定义的口径误导消费方，不如让它缺席。消费方**不得**用 `path === 'relay'` 反推它。
     */
    degraded?: boolean
  }
}

export interface MobileEvents {
  'mobile.event.visibility': { state: 'foreground' | 'background'; at: number }
  'mobile.event.viewing': { sessionId: string | null }
}

// ───────────────────────────── 推导辅助 ─────────────────────────────

export type ParamsOf<A, K extends keyof A> = A[K] extends { params: infer P } ? P : never
export type ResultOf<A, K extends keyof A> = A[K] extends { result: infer R } ? R : never

/** 由方法表推导的类型安全客户端（手机侧用它调 `host.*`）。 */
export interface TypedCaller<A> {
  call<K extends keyof A & string>(method: K, params: ParamsOf<A, K>, timeoutMs?: number): Promise<ResultOf<A, K>>
}

/** 由方法表推导的 handler 实现类型（电脑侧用它实现 `host.*`，key 必须齐全）。 */
export type HandlerImpl<A> = {
  [K in keyof A & string]: (params: ParamsOf<A, K>, ctx: CallContext) => ResultOf<A, K> | Promise<ResultOf<A, K>>
}

/** 由事件表推导的订阅辅助。 */
export interface TypedSubscriber<E> {
  subscribe<K extends keyof E & string>(topic: K, listener: (payload: E[K]) => void): () => void
}

export function createCaller<A>(endpoint: Endpoint): TypedCaller<A> {
  return {
    call<K extends keyof A & string>(method: K, params: ParamsOf<A, K>, timeoutMs?: number): Promise<ResultOf<A, K>> {
      return endpoint.call(method, params, timeoutMs === undefined ? undefined : { timeoutMs }) as Promise<ResultOf<A, K>>
    },
  }
}

export function createSubscriber<E>(endpoint: Endpoint): TypedSubscriber<E> {
  return {
    subscribe<K extends keyof E & string>(topic: K, listener: (payload: E[K]) => void): () => void {
      return endpoint.subscribe(topic, listener as (payload: unknown) => void)
    },
  }
}

/** 把一份 handler 实现注册到 endpoint（key 必须齐全，返回值类型必须匹配）。 */
export function registerHandlers<A>(endpoint: Endpoint, impl: HandlerImpl<A>): void {
  for (const method of Object.keys(impl)) {
    const fn = impl[method as keyof A & string] as (params: unknown, ctx: CallContext) => unknown
    endpoint.handle(method, (params, ctx) => Promise.resolve(fn(params, ctx)))
  }
}
