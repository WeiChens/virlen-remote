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
  /** 纯文本投影；图片等富内容一期剥离为占位符（§7-⑦）。空串 = 无正文（手机端不渲染空气泡）。 */
  text: string
  createdAt: number
  /**
   * 工具名（仅 `role:'tool'`，如 `read_file`）。
   *
   * 来源：电脑侧用 `toolCallId` 反查发起该调用的 assistant 消息的 `toolCalls[].name`
   * （与桌面 `message-list/helpers.ts::resolveJumpAnchorId` 同一套匹配规则）。
   * 手机端**不猜**：拿不到就只显示「工具」。
   */
  toolName?: string
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

// ───────────────────────────── 方法表 ─────────────────────────────

export interface SendParams {
  sessionId: string
  text: string
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
  /** 模型服务与模型 id；不传 = 沿用默认 Agent 的默认模型。 */
  providerConfigId?: string
  modelId?: string
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
   * 一期只发 `mode='full'`，二期改发 `mode='delta'`，**协议表不变**（§3.6）。
   */
  'host.event.message.stream': {
    sessionId: string
    messageId: string
    seq: number
    mode: 'full' | 'delta'
    text: string
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
  'host.event.connection.changed': { path: 'direct' | 'relay'; degraded: boolean }
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
