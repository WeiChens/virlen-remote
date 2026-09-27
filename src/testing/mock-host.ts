/**
 * Mock 宿主数据源 —— 供「浏览器 harness」与单测使用。
 *
 * 行为：`send` 立即回投递确认（`messageId`），随后**异步**推送
 * `message.added`（用户消息）→ `runtime.changed`（working）→ 多次 `message.stream`（full 模式）
 * → `message.added`（AI 完整消息）+ `runtime.changed`（空闲）。
 *
 * 这正是 §3.3「RPC 只做投递确认、过程走事件」的可运行样例。
 *
 * ⚠️ **订阅门（§24，2026-09-29）**：消息 / 流式 / 运行时 / 占用这四类事件**只推已订阅的会话**
 * （`host.event.session.list.changed` 与交互事件恒推）——与真实电脑侧（`store-bridge` 的
 * `subscriptions.has(s.id)`）**同一条规则**。
 *
 * 为何必须一致：mock 过去无条件推送，于是「客户端忘了 `host.session.subscribe`」这类缺陷在
 * 联调 / 单测里**完全看不见**，真机上才表现为「新建会话的标题更新了，但消息永远是空的」。
 * mock 比真机宽松 = 测试对着假行为发绿灯，这条闸是故意的：宁可让用例早失败。
 */
import { BridgeError } from '../protocol/errors'
import { answerActionError, normalizeChoiceAnswer } from '../protocol/answer'
import { COMPRESS_MIN_RATIO, DEFAULT_CONTEXT_WINDOW_TOKENS } from '../protocol/api'
import type { HostDataSource, HostEmit } from '../protocol/host'
import type { HostEvents } from '../protocol/api'
import type {
  AnswerParams,
  AnswerResult,
  ApprovalTier,
  CompressParams,
  ContextInfoDTO,
  ContextParams,
  CreateSessionParams,
  DeleteSessionParams,
  InteractionDTO,
  MessageDTO,
  ModelProviderDTO,
  MsgPageDTO,
  MsgPageParams,
  PinSessionParams,
  RenameSessionParams,
  SendParams,
  SessionSummaryDTO,
  SetModelParams,
  WorkspaceOptionDTO,
} from '../protocol/api'
import type { HelloParams, HelloResult } from '../protocol/hello'

export interface MockHostOptions {
  /** 流式段数。 */
  streamSteps?: number
  /** 每段间隔（ms）。 */
  streamDelayMs?: number
  /**
   * `demo-1` 的预置消息条数（默认 2）。
   *
   * 供分页验证 / harness 压测用：默认值下只有 2 条，永远触发不了「还有更早的消息」。
   */
  demoMessageCount?: number
  /**
   * 给 `demo-1` 追加一条带工具名的工具消息（默认关：会改变默认消息条数，影响分页用例）。
   *
   * 打开后手机端能看到「工具 · list_files」气泡（harness 人工验证用）。
   */
  demoToolMessage?: boolean
}

/** 构造演示用交互（供 harness / 单测触发手机端卡片）。 */
export interface MockInteractionSpec {
  kind?: 'choice' | 'authorization'
  tier?: ApprovalTier
  sessionId?: string
  question?: string
  options?: string[]
  multi?: boolean
  permName?: string
  title?: string
  subTitle?: string
  desc?: string
  hint?: string
  risk?: string
  sandboxBypass?: boolean
  presentation?: 'modal' | 'terminal'
}

export interface MockHostDataSource extends HostDataSource {
  /** 由 harness / 测试在注册后回填（把 `HostEvents` 推给对端）。 */
  bind(emit: HostEmit): void
  /** 推一个待应答交互给手机（返回其 `interactionId`）。 */
  triggerInteraction(spec?: MockInteractionSpec): string
  /** 当前仍挂起的交互 id。 */
  pendingInteractions(): string[]
  /**
   * 已收到的 RPC 方法名流水（M5）。
   *
   * 供单测断言「请求确实到达了电脑侧」—— 否则只能靠副作用反推，
   * 而像 `cancel` 这种「无事发生」的方法就没有可观察的副作用。
   */
  readonly calls: string[]
  /** 手动推一次上下文占用变化（模拟电脑侧使用量增长 / 压缩），供手机端 UI 联调。 */
  bumpContext(sessionId: string, tokens: number): void
  /**
   * 手动推一次「工具参数生成进度」（§27），供手机端 UI 联调 / 单测。
   *
   * 真实链路里由引擎的 `AgentEvent.tool_progress` 驱动 —— 那是 provider 在**累积 tool 参数**
   * 期间唯一的事件（其余时间静默）。`progress = null` 表示清空（工具开始执行 / 本轮结束）。
   */
  setToolProgress(sessionId: string, progress: { name: string; chars: number } | null): void
}

/** 演示用模型服务（与 `sessions` 里的 provider 字段一致）。 */
const DEMO_PROVIDERS: ModelProviderDTO[] = [
  { id: 'p-openai', name: 'OpenAI（演示）', models: ['gpt-4o', 'gpt-4o-mini'] },
  { id: 'p-anthropic', name: 'Anthropic（演示）', models: ['claude-sonnet-4'] },
]

/** 演示用工作目录候选集（新建会话只能从这里选）。 */
const DEMO_WORKSPACES = ['E:/code/virlen-demo', 'E:/code/another-project']

export function createMockHostDataSource(options: MockHostOptions = {}): MockHostDataSource {
  const streamSteps = options.streamSteps ?? 3
  const streamDelayMs = options.streamDelayMs ?? 40

  let emit: HostEmit | null = null

  /**
   * 已订阅的会话（与真实电脑侧的 `SubscriptionRegistry` 同语义）。
   *
   * 未订阅的会话：只有会话列表（`session.list.changed`）与交互事件会推给对端 ——
   * 消息 / 流式 / 运行时 / 占用一律不推（见文件头「订阅门」）。
   */
  const subscribed = new Set<string>()

  /** 会话维度的事件推送（受订阅门约束）。 */
  function emitFor<K extends keyof HostEvents & string>(
    sessionId: string,
    topic: K,
    payload: HostEvents[K],
  ): void {
    if (!subscribed.has(sessionId)) return
    emit?.(topic, payload)
  }

  /** RPC 方法名流水（见 `MockHostDataSource.calls`）。 */
  const calls: string[] = []

  const sessions: SessionSummaryDTO[] = [
    {
      id: 'demo-1',
      title: '演示：手机控制',
      updatedAt: Date.now(),
      working: false,
      agentId: 'agent-virlen',
      agentName: 'Virlen',
      workspace: DEMO_WORKSPACES[0],
      providerConfigId: 'p-openai',
      providerName: 'OpenAI（演示）',
      modelId: 'gpt-4o',
    },
    {
      id: 'demo-2',
      title: '空会话',
      updatedAt: Date.now() - 60_000,
      working: false,
      agentId: 'agent-reviewer',
      agentName: '代码评审员',
      workspace: DEMO_WORKSPACES[1],
      providerConfigId: 'p-anthropic',
      providerName: 'Anthropic（演示）',
      modelId: 'claude-sonnet-4',
    },
  ]
  const messages = new Map<string, MessageDTO[]>()
  const demoCount = options.demoMessageCount ?? 2
  messages.set(
    'demo-1',
    demoCount <= 2
      ? [
          { id: 'm1', role: 'user', text: '你好，帮我看下今天的安排', createdAt: Date.now() - 120_000 },
          { id: 'm2', role: 'assistant', text: '好的，我来看看。', createdAt: Date.now() - 110_000 },
        ]
      : Array.from({ length: demoCount }, (_, i) => ({
          id: `m${i}`,
          role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
          text: `演示消息 #${i}`,
          createdAt: Date.now() - (demoCount - i) * 1000,
        })),
  )
  messages.set('demo-2', [])
  if (options.demoToolMessage) {
    messages.get('demo-1')?.push(
      {
        id: 'tool-1',
        role: 'tool',
        text: 'src/index.ts\nsrc/store.ts\nsrc/ui/pages/Chat.tsx',
        createdAt: Date.now() - 105_000,
        toolName: 'list_files',
      },
      {
        id: 'empty-assistant',
        role: 'assistant',
        text: '',
        createdAt: Date.now() - 100_000,
      },
    )
  }

  /**
   * 上下文占用（模拟电脑侧口径：最后一条带 usage / contextTokens 的消息）。
   *
   * `demo-2` 特意给一个很低的占用 —— 让手机端「上下文充裕时不显示压缩」的分支可验证。
   */
  const contextTokens = new Map<string, number>([
    ['demo-1', 120_000],
    ['demo-2', 1_000],
  ])

  let counter = 0
  const nextId = (prefix: string) => `${prefix}-${++counter}-${Date.now().toString(36)}`

  /** 待应答交互（模拟电脑侧的交互注册表）。 */
  const interactions = new Map<string, InteractionDTO>()

  /** 被「暂存」而暂停的会话（模拟电脑侧的 paused 运行态，供 resume 演示 / 测试）。 */
  const pausedSessions = new Set<string>()

  function emitList(): void {
    emit?.('host.event.session.list.changed', { sessions: sessions.map((s) => ({ ...s })) })
  }
  async function streamReply(sessionId: string, list: MessageDTO[]): Promise<void> {
    const messageId = nextId('a')
    let text = ''
    // 模拟生成过程中的积压：内容真实增长 → 流式帧逐次变长（与真实电脑侧 mode='full' 同形）
    list.push({ id: messageId, role: 'assistant', text: '', createdAt: Date.now() })
    for (let i = 0; i < streamSteps; i++) {
      await delay(streamDelayMs)
      text += `这是模拟流式的第 ${i + 1} 段。`
      emitFor(sessionId, 'host.event.message.stream', { sessionId, messageId, seq: i, mode: 'full', text, final: false })
    }
    await delay(streamDelayMs)
    const finalMessage: MessageDTO = {
      id: messageId,
      role: 'assistant',
      text,
      createdAt: Date.now(),
    }
    // 定稿：就地替换那条临时消息（与电脑侧「流式期间不发 message.updated」的语义对齐）
    const idx = list.findIndex((m) => m.id === messageId)
    if (idx >= 0) list[idx] = finalMessage
    else list.push(finalMessage)
    emitFor(sessionId, 'host.event.message.stream', { sessionId, messageId, seq: streamSteps, mode: 'full', text, final: true })
    emitFor(sessionId, 'host.event.message.added', { sessionId, message: finalMessage })
    emitFor(sessionId, 'host.event.session.runtime.changed', { sessionId, runtime: { working: false } })
    // 生成一轮 → 上下文占用增长（手机端可看到实时变化）
    bumpContext(sessionId, (contextTokens.get(sessionId) ?? 0) + 2_000)
    const session = sessions.find((s) => s.id === sessionId)
    if (session) {
      session.working = false
      session.updatedAt = Date.now()
    }
  }

  /** 推一次上下文变化（内部与 harness 共用）—— 同样受订阅门约束。 */
  function bumpContext(sessionId: string, tokens: number): void {
    contextTokens.set(sessionId, tokens)
    emitFor(sessionId, 'host.event.session.context.changed', { sessionId, context: contextOf(sessionId) })
  }

  /** 推一次工具参数生成进度（§27）—— 同上，受订阅门约束。 */
  function setToolProgress(
    sessionId: string,
    progress: { name: string; chars: number } | null,
  ): void {
    emitFor(sessionId, 'host.event.session.runtime.changed', {
      sessionId,
      // 参数累积期一定是 working（真实链路里两者同源）；progress=null 即清空
      runtime: { working: true, ...(progress ? { toolProgress: progress } : {}) },
    })
  }

  function contextOf(sessionId: string): ContextInfoDTO {
    const tokens = contextTokens.get(sessionId)
    return {
      tokens: tokens ?? null,
      windowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    }
  }

  const host: MockHostDataSource = {
    calls,
    bind(fn) {
      emit = fn
    },
    /**
     * 模拟配对校验 + 授权凭证签发（M6 口径，见 docs/phone-control-bridge.md §30）：
     *
     * - 无 token → 拒（`invalid`）
     * - `token === 'expired'` → 凭证过期（`data.reason='expired'`）
     * - `token === 'removed'` → 手机已被电脑端移除（`data.reason='revoked'`）
     * - `token === 'ticket-old'` → 二维码已过期（`data.reason='ticket-expired'`）
     * - 其它非空 token → 通过，并**回传一条授权凭证**（手机端存的应该是它，不是手上那张票）
     */
    async hello(params: HelloParams): Promise<HelloResult> {
      const token = params.token
      if (!token) {
        throw new BridgeError('E_DENIED', '缺少配对令牌', { data: { reason: 'invalid' } })
      }
      if (token === 'expired') {
        throw new BridgeError('E_DENIED', '令牌已过期', { data: { reason: 'expired' } })
      }
      if (token === 'removed') {
        throw new BridgeError('E_DENIED', '该设备已被电脑端移除', { data: { reason: 'revoked' } })
      }
      if (token === 'ticket-old') {
        throw new BridgeError('E_DENIED', '二维码已过期', { data: { reason: 'ticket-expired' } })
      }
      const now = Date.now()
      return {
        protocolVersion: params.protocolVersion,
        host: { platform: 'web-harness', appVersion: '0.0.0' },
        capabilities: [
          'session.list',
          'session.send',
          'session.cancel',
          'session.resume',
          'session.create',
          'session.rename',
          'session.pin',
          'session.delete',
          'interaction.answer',
          'stream.delta',
          'session.model',
          'session.workspace',
          'session.context',
          'session.compress',
        ],
        paired: true,
        deviceName: 'Virlen 电脑（演示）',
        deviceId: 'demo-host',
        // M6：派发授权凭证（30 天）—— 手机端应把它存起来，下次直接连
        grant: {
          token: 'gt-demo',
          issuedAt: now,
          expiresAt: now + 30 * 24 * 60 * 60 * 1000,
          lastSeenAt: now,
        },
      }
    },
    async listSessions() {
      return sessions.map((s) => ({ ...s }))
    },
    async getMessages(params: MsgPageParams): Promise<MsgPageDTO> {
      calls.push(params.fromRowid != null ? 'host.session.messages(older)' : 'host.session.messages')
      const list = messages.get(params.sessionId) ?? []
      const limit = params.limit ?? 50
      // 游标 = 已返回窗口中最旧一条的下标（与真实电脑侧的 rowid 同形：不透明、原样回传）
      if (params.fromRowid != null) {
        const end = Math.max(0, Math.min(params.fromRowid, list.length))
        const start = Math.max(0, end - limit)
        return {
          messages: list.slice(start, end).map((m) => ({ ...m })),
          hasMore: start > 0,
          cursor: start > 0 ? start : null,
        }
      }
      const start = Math.max(0, list.length - limit)
      return {
        messages: list.slice(start).map((m) => ({ ...m })),
        hasMore: start > 0,
        cursor: start > 0 ? start : null,
      }
    },
    async getMessage(params: { sessionId: string; messageId: string }) {
      const list = messages.get(params.sessionId) ?? []
      const found = list.find((m) => m.id === params.messageId)
      if (!found) throw new BridgeError('E_NOT_FOUND', `message not found: ${params.messageId}`)
      return { ...found }
    },
    async send(params: SendParams) {
      calls.push('host.session.send')
      const list = messages.get(params.sessionId)
      if (!list) throw new BridgeError('E_NOT_FOUND', `session not found: ${params.sessionId}`)
      const userMessage: MessageDTO = {
        id: nextId('u'),
        role: 'user',
        text: params.text,
        createdAt: Date.now(),
      }
      list.push(userMessage)
      emitFor(params.sessionId, 'host.event.message.added', { sessionId: params.sessionId, message: userMessage })
      emitFor(params.sessionId, 'host.event.session.runtime.changed', {
        sessionId: params.sessionId,
        runtime: { working: true },
      })
      const session = sessions.find((s) => s.id === params.sessionId)
      if (session) {
        session.working = true
        session.updatedAt = Date.now()
      }
      void streamReply(params.sessionId, list)
      return { messageId: userMessage.id }
    },
    async cancel() {
      calls.push('host.session.cancel')
      return { ok: true as const }
    },
    async resume(params: { sessionId: string }) {
      calls.push('host.session.resume')
      if (!sessions.some((s) => s.id === params.sessionId)) {
        throw new BridgeError('E_NOT_FOUND', `session not found: ${params.sessionId}`)
      }
      pausedSessions.delete(params.sessionId)
      emitFor(params.sessionId, 'host.event.session.runtime.changed', {
        sessionId: params.sessionId,
        runtime: { working: true },
      })
      return { ok: true as const }
    },
    /**
     * 记录订阅（与真实电脑侧同语义：只推已订阅会话的会话维度事件）。
     *
     * ⚠️ 真实电脑侧还会先 `requireSession`（未知名会话 → `E_NOT_FOUND`），mock 保持一致：
     * 否则「客户端订阅了一个不存在的会话」这类接线错误在单测里喑默通过。
     */
    async subscribe(params: { sessionId: string }) {
      calls.push('host.session.subscribe')
      if (!sessions.some((s) => s.id === params.sessionId)) {
        throw new BridgeError('E_NOT_FOUND', `session not found: ${params.sessionId}`)
      }
      subscribed.add(params.sessionId)
      return { ok: true as const }
    },
    /**
     * 模拟「终端内确认」（`presentation:'terminal'`）：
     * 手机只能原样放行 / 拒绝；电脑侧落点是 `terminalConfirmSubmit/Cancel`（§16.4）。
     */
    triggerInteraction(spec: MockInteractionSpec = {}): string {
      const interactionId = nextId('it')
      const kind = spec.kind ?? 'authorization'
      const interaction: InteractionDTO = {
        interactionId,
        sessionId: spec.sessionId ?? 'demo-1',
        toolCallId: nextId('tc'),
        kind,
        createdAt: Date.now(),
        tier: spec.tier ?? 'low',
        question: spec.question,
        options: spec.options,
        multi: spec.multi,
        permName: spec.permName,
        title: spec.title ?? (kind === 'authorization' ? '执行命令' : undefined),
        subTitle: spec.subTitle,
        desc: spec.desc,
        hint: spec.hint,
        risk: spec.risk,
        sandboxBypass: spec.sandboxBypass,
        presentation: spec.presentation ?? 'modal',
      }
      interactions.set(interactionId, interaction)
      emit?.('host.event.interaction.requested', { interaction })
      return interactionId
    },
    /**
     * 应答：与真实电脑侧同样的**独立校验**（高风险批准必须带 `confirmed`；
     * 选择结果必须能规范化成非空回执）—— 演示 / 测试才能真实反映「手机 UI 漏改不算放行」。
     */
    async answer(params: AnswerParams): Promise<AnswerResult> {
      const interaction = interactions.get(params.interactionId)
      if (!interaction) return { accepted: false, reason: 'not-found' }
      // 动作合法性：与真实电脑侧（`interaction-registry`）**共用同一份**判据 ——
      // mock 偏宽松会让「手机 UI 的动作与交互类型不匹配」这类缺陷测不出来（§18.6）。
      const actionError = answerActionError(interaction, params.action)
      if (actionError) return { accepted: false, reason: actionError }
      if (params.action === 'allow' && interaction.tier === 'high' && params.confirmed !== true) {
        return { accepted: false, reason: 'confirm-required' }
      }
      if (params.action === 'choose' && !normalizeChoiceAnswer(params.value)) {
        return { accepted: false, reason: 'invalid-value' }
      }
      interactions.delete(params.interactionId)
      // 暂存 → 会话进入「暂停运行」态（供手机端显示「继续」，与电脑侧 paused 语义一致）
      if (params.action === 'shelve') {
        pausedSessions.add(interaction.sessionId)
        emitFor(interaction.sessionId, 'host.event.session.runtime.changed', {
          sessionId: interaction.sessionId,
          runtime: { working: false, paused: true },
        })
      }
      emit?.('host.event.interaction.resolved', {
        interactionId: params.interactionId,
        by: 'mobile',
        outcome: params.action === 'allow' ? 'allow' : params.action === 'shelve' ? 'shelve' : 'deny',
      })
      return { accepted: true }
    },
    pendingInteractions() {
      return [...interactions.keys()]
    },
    async listInteractions(): Promise<InteractionDTO[]> {
      return [...interactions.values()].map((i) => ({ ...i }))
    },
    // ── M4 写操作 ──
    async createSession(params: CreateSessionParams) {
      calls.push('host.session.create')
      const id = nextId('s')
      // 工作目录：**与真实电脑侧同一条防线** —— 候选集由电脑侧给出，手机不能自造（§22.3）
      let workspace: string | undefined
      if (params.workspace != null) {
        const match = DEMO_WORKSPACES.find((w) => w === params.workspace)
        if (!match) {
          throw new BridgeError('E_BAD_REQUEST', `工作目录不在电脑侧既有目录内：${params.workspace}`)
        }
        workspace = match
      }
      const model = resolveModel(params.providerConfigId, params.modelId)
      sessions.unshift({
        id,
        title: params.title || '手机新建的会话',
        updatedAt: Date.now(),
        working: false,
        agentId: 'agent-virlen',
        agentName: 'Virlen',
        workspace: workspace ?? DEMO_WORKSPACES[0],
        ...model,
      })
      messages.set(id, [])
      contextTokens.set(id, 0)
      // 与真实电脑侧同一条兜底（§24）：**自建的会话直接纳入订阅集合** ——
      // 客户端创建会话的意图就是要马上看它，订阅不该押在它记得再调一次 RPC 上。
      subscribed.add(id)
      emitList()
      return { sessionId: id }
    },
    async renameSession(params: RenameSessionParams) {
      const session = sessions.find((s) => s.id === params.sessionId)
      if (!session) throw new BridgeError('E_NOT_FOUND', `session not found: ${params.sessionId}`)
      session.title = params.title
      session.updatedAt = Date.now()
      emitList()
      return { ok: true as const }
    },
    async setPinned(params: PinSessionParams) {
      const session = sessions.find((s) => s.id === params.sessionId)
      if (!session) throw new BridgeError('E_NOT_FOUND', `session not found: ${params.sessionId}`)
      ;(session as { pinned?: boolean }).pinned = params.pinned
      emitList()
      return { ok: true as const }
    },
    async deleteSession(params: DeleteSessionParams) {
      if (params.confirm !== true) {
        throw new BridgeError('E_CONFIRM_REQUIRED', '删除会话需二次确认')
      }
      const idx = sessions.findIndex((s) => s.id === params.sessionId)
      if (idx === -1) throw new BridgeError('E_NOT_FOUND', `session not found: ${params.sessionId}`)
      sessions.splice(idx, 1)
      messages.delete(params.sessionId)
      contextTokens.delete(params.sessionId)
      emitList()
      return { ok: true as const }
    },
    // ── §22：模型 / 工作目录 / 上下文 ──
    async listModels() {
      calls.push('host.model.list')
      return DEMO_PROVIDERS.map((p) => ({ ...p, models: [...p.models] }))
    },
    async setModel(params: SetModelParams) {
      calls.push('host.session.setModel')
      const session = sessions.find((s) => s.id === params.sessionId)
      if (!session) throw new BridgeError('E_NOT_FOUND', `session not found: ${params.sessionId}`)
      Object.assign(session, resolveModel(params.providerConfigId, params.modelId))
      emitList()
      return { ok: true as const }
    },
    async listWorkspaces(): Promise<WorkspaceOptionDTO[]> {
      calls.push('host.workspace.list')
      return DEMO_WORKSPACES.map((path) => ({
        path,
        name: path.split('/').pop() ?? path,
        sessionCount: sessions.filter((s) => s.workspace === path).length,
      }))
    },
    async getContext(params: ContextParams): Promise<ContextInfoDTO> {
      calls.push('host.session.context')
      if (!sessions.some((s) => s.id === params.sessionId)) {
        throw new BridgeError('E_NOT_FOUND', `session not found: ${params.sessionId}`)
      }
      return contextOf(params.sessionId)
    },
    /**
     * 压缩上下文：**与真实电脑侧同判据**（confirm + 最小占用比例），
     * 然后把消息换成一条 summary，并推 `messages.reset`（手机重拉窗口）。
     */
    async compress(params: CompressParams) {
      calls.push('host.session.compress')
      if (params.confirm !== true) {
        throw new BridgeError('E_CONFIRM_REQUIRED', '压缩上下文需二次确认（confirm:true）')
      }
      if (!sessions.some((s) => s.id === params.sessionId)) {
        throw new BridgeError('E_NOT_FOUND', `session not found: ${params.sessionId}`)
      }
      const context = contextOf(params.sessionId)
      const tokens = context.tokens ?? 0
      if (tokens < context.windowTokens * COMPRESS_MIN_RATIO) {
        throw new BridgeError('E_BAD_REQUEST', '当前上下文很充裕，无需压缩')
      }
      const summary: MessageDTO = {
        id: nextId('sum'),
        role: 'system',
        text: '[上下文摘要] 之前的内容已压缩为摘要。',
        createdAt: Date.now(),
      }
      messages.set(params.sessionId, [summary])
      emitFor(params.sessionId, 'host.event.session.messages.reset', { sessionId: params.sessionId })
      emitFor(params.sessionId, 'host.event.message.added', { sessionId: params.sessionId, message: summary })
      bumpContext(params.sessionId, 2_000)
      return { ok: true as const }
    },
    /** 手动推一次占用变化（harness 按钮 / 测试用）。 */
    bumpContext,
    setToolProgress,
  }

  return host
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把 `providerConfigId` / `modelId` 解析成会话上的三个展示 / 切换字段（非法组合 → E_BAD_REQUEST）。 */
function resolveModel(
  providerConfigId?: string,
  modelId?: string,
): Pick<SessionSummaryDTO, 'providerConfigId' | 'providerName' | 'modelId'> {
  if (providerConfigId == null && modelId == null) {
    return { providerConfigId: DEMO_PROVIDERS[0].id, providerName: DEMO_PROVIDERS[0].name, modelId: DEMO_PROVIDERS[0].models[0] }
  }
  const provider = DEMO_PROVIDERS.find((p) => p.id === providerConfigId)
  if (!provider) throw new BridgeError('E_BAD_REQUEST', `模型服务不存在或未启用：${providerConfigId}`)
  if (!modelId || !provider.models.includes(modelId)) {
    throw new BridgeError('E_BAD_REQUEST', `该服务下没有模型：${modelId}`)
  }
  return { providerConfigId: provider.id, providerName: provider.name, modelId }
}
