/**
 * Mock 宿主数据源 —— 供「浏览器 harness」与单测使用。
 *
 * 行为：`send` 立即回投递确认（`messageId`），随后**异步**推送
 * `message.added`（用户消息）→ `runtime.changed`（working）→ 多次 `message.stream`
 * → `message.added`（AI 完整消息）+ `runtime.changed`（空闲）。
 *
 * 流式帧的形状**由客户端在 `hello` 里声明**（`streamMode`，默认 `full`）：`delta` 时只发新增后缀
 * （带 `offset`），规则与真实电脑侧（`store-bridge.ts` 的 `pushStream`）**逐条对齐**：
 * 消息首帧 / 正文被改写 / `final` 收尾帧都发**整段**，只有「新正文以已发出内容为前缀」时才发增量。
 * 两边不一致的后果很具体：mock 宽松 = 用例对着假行为发绿灯（§24 的教训）。
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
import { COMPRESS_MIN_RATIO, DEFAULT_CONTEXT_WINDOW_TOKENS, MESSAGES_DETAIL_CAPABILITY } from '../protocol/api'
import {
  COMPRESS_MODE_CAPABILITY,
  DEFAULT_COMPRESS_MODE,
  compressModeOf,
  type CompressMode,
} from '../protocol/compress'
import { MESSAGE_DELETE_CAPABILITY, MESSAGE_QUOTE_CAPABILITY } from '../protocol/message-actions'
import { MESSAGE_FILE_CAPABILITY, sanitizeFileRefs } from '../protocol/message-files'
import { SESSION_AGENT_CAPABILITY } from '../protocol/agents'
import { summarizeToolArgs, formatToolArgs } from '../protocol/tool-args'
import {
  FILE_BROWSE_CAPABILITY,
  FILE_CHUNK_BYTES,
  FILE_DOWNLOAD_CAPABILITY,
  FILE_EDIT_CAPABILITY,
  FILE_EDIT_MAX_BYTES,
  FILE_LIST_MAX_ENTRIES,
  FILE_UPLOAD_CAPABILITY,
  FILE_UPLOAD_MAX_BYTES,
  base64ToBytes,
  baseNameOfPath,
  bytesToBase64,
  compareFileEntries,
  duplicateNameCandidate,
  fileTransferDeniedReason,
  formatFileSize,
  isEditableFileName,
  isSafeEntryName,
  mimeTypeOf,
  normalizeRelPath,
  previewKindOf,
} from '../protocol/files'
import type { HostDataSource, HostEmit } from '../protocol/host'
import type { HostEvents, StreamMode } from '../protocol/api'
import type {
  AgentOptionDTO,
  AnswerParams,
  AnswerResult,
  ApprovalTier,
  CompressParams,
  ContextInfoDTO,
  ContextParams,
  CreateSessionParams,
  DeleteMessageParams,
  DeleteSessionParams,
  FileEntryDTO,
  FileListParams,
  FileListResult,
  FileReadParams,
  FileReadResult,
  FileWriteAbortParams,
  FileWriteBeginParams,
  FileWriteBeginResult,
  FileWriteChunkParams,
  FileWriteChunkResult,
  FileWriteFinishParams,
  FileWriteFinishResult,
  InteractionDTO,
  MessageDTO,
  ModelProviderDTO,
  MsgPageDTO,
  MsgPageParams,
  PinSessionParams,
  RenameSessionParams,
  RunningToolDTO,
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
  /**
   * 模拟链路通讯类型（§37）：`'relay'` 时**所有 `host.file.*` 一律拒**，
   * 与真实电脑侧的「非中继才给传文件」同一条口径（文案也同一句）。
   *
   * 为何要能模拟：手机端「中继时置灰入口」与「电脑端拒了之后怎么提示」是两条独立分支，
   * 而不给一个会拒的宿主就测不到后者的错误路径。
   */
  fileLinkKind?: 'direct' | 'relay'
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
  /**
   * 手动推一次「**正在执行中**的工具」（`RuntimeDTO.runningTools`），供手机端 UI 联调 / 单测。
   *
   * 与 `setToolProgress` 是一对（先后相接的两个阶段）：参数累积期看 `toolProgress`，
   * 工具开始执行到结果回来之间看 `runningTools`。传 `null` = **跑完了**（一并把 `working` 收掉，
   * 真机上工具跑完要么接着下一轮、要么整个 run 结束）；传空数组 = 这次执行中的工具都结束了，
   * 但会话仍在跑（模型正在接着思考）。
   *
   * ⚠️ 真实电脑侧没有这个「手动口」：那些字段是 `store-bridge` 从会话消息（assistant 的
   * `toolCalls[]` 减去已有结果）**推导**出来的（§27 的姊妹字段），mock 手推是为了让手机端
   * 在**没有引擎**的情况下也能看到这一帧。
   */
  setRunningTools(sessionId: string, tools: RunningToolDTO[] | null): void
  /**
   * 读一份**演示文件树**里的文件（测试 / harness 断言用）—— `null` = 不存在。
   *
   * 为什么需要：上传是否真的落到「正确的相对路径、正确的字节」只能从宿主侧看，
   * 而手机端的 RPC 应答只说「成功了」。只测应答 = 测了个寂寞。
   */
  readMockFile(sessionId: string, relPath: string): Uint8Array | null
  /** 往演示文件树里放一个文件（建目录是隐式的）。 */
  writeMockFile(sessionId: string, relPath: string, content: string | Uint8Array): void
  /** 当前文件树里的全部相对路径（排序后）。 */
  listMockFiles(sessionId: string): string[]
  /**
   * 最后**真正执行**的那次压缩（`null` = 还没压过）—— 测试 / harness 观察口。
   *
   * 为什么需要：手机端的 RPC 应答只是一句 `{ok:true}`，它只说「电脑侧受理了」，**不说用了哪种方式**
   * —— 而「选中了正文压缩却走了 AI 摘要（还花了钱）」正是这个参数最危险的失败形态。
   */
  lastCompress(): { sessionId: string; mode: CompressMode } | null
}

/** 演示用模型服务（与 `sessions` 里的 provider 字段一致）。 */
const DEMO_PROVIDERS: ModelProviderDTO[] = [
  { id: 'p-openai', name: 'OpenAI（演示）', models: ['gpt-4o', 'gpt-4o-mini'] },
  { id: 'p-anthropic', name: 'Anthropic（演示）', models: ['claude-sonnet-4'] },
]

/** 演示用工作目录候选集（新建会话只能从这里选）。 */
const DEMO_WORKSPACES = ['E:/code/virlen-demo', 'E:/code/another-project']

/**
 * 演示文件树的固定修改时刻 —— 不取 `Date.now()`：否则用例只能对着「大于某刻」断言，
 * 而手机上要显示「3 分钟前修改」时又得再多一层换算。
 */
const DEMO_FILE_MTIME = Date.UTC(2026, 9, 1, 12, 0, 0)

/**
 * 标准 1×1 透明 PNG（68 字节）。
 *
 * 为什么放一个**真的**图片字节而不是随便一段文本叫 `logo.png`：图片预览这条路要验证的是
 * 「字节 → base64 → Blob → ObjectURL → <img> 真的能显示」，而假图片会让这条路永远发绿灯。
 */
const DEMO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** 演示文件树的初始内容（文本 / base64 两种写法）。 */
const DEMO_TREE_SPEC: Array<{ path: string; text?: string; base64?: string }> = [
  {
    path: 'README.md',
    text: '# Virlen 演示项目\n\n这是一个用于验证**手机端文件浏览**的演示目录。\n\n- `src/` 下有 TypeScript 源码\n- `assets/logo.png` 是一张小图\n- `build/app.bin` 是未知类型（只能下载）\n',
  },
  {
    path: 'src/index.ts',
    text: [
      // ⚠️ 演示内容里**不要**写相对导入说明符（构建脚本会把产物中所有形如相对导入的字符串
      // 补上 `.js` 后缀，于是这段演示文本会被误报一句告警）。用路径别名即可。
      "import { createApp } from '@/app'",
      '',
      'const app = createApp({ port: 3000 })',
      'app.start()',
      '',
    ].join('\n'),
  },
  {
    path: 'src/store/chat.ts',
    text: [
      'export interface ChatState {',
      '  messages: string[]',
      '  working: boolean',
      '}',
      '',
      'export const INITIAL: ChatState = { messages: [], working: false }',
      '',
    ].join('\n'),
  },
  { path: 'src/app.ts', text: 'export function createApp(config: { port: number }) {\n  return { start: () => console.log(config.port) }\n}\n' },
  {
    path: 'package.json',
    text: '{\n  "name": "virlen-demo",\n  "version": "1.0.0",\n  "private": true\n}\n',
  },
  { path: 'docs/notes.txt', text: '手机端浏览这个目录时，应该看到 src/ 与 docs/ 两个子目录。\n' },
  { path: '.gitignore', text: 'node_modules/\ndist/\n' },
  { path: 'assets/logo.png', base64: DEMO_PNG_BASE64 },
  // 未知扩展名 → `previewKindOf` 给 binary → 手机端只给「下载」（这条路必须有用例盯着）
  { path: 'build/app.bin', text: 'not-a-real-binary-but-unknown-extension' },
]

/**
 * 演示文件树的一格：**字节 + 修改时刻**。
 *
 * 为何要把 `mtimeMs` 放进树里（而不是像原来那样给所有条目一个常量）：编辑保存要按「打开时的
 * mtime」做冲突校验 —— 手机端改完再存、而期间电脑侧这份文件被改过就该拒。常量时间戳下这条
 * 路径永远走不到（写盘不改 mtime = 永远不冲突）。
 */
interface MockFile {
  bytes: Uint8Array
  mtimeMs: number
}

/** 建一份演示文件树（相对工作目录的路径 → 文件）。每份工作目录各得一份，互不影响。 */
function createDemoTree(): Map<string, MockFile> {
  const encoder = new TextEncoder()
  const tree = new Map<string, MockFile>()
  for (const item of DEMO_TREE_SPEC) {
    tree.set(item.path, {
      bytes: item.base64 ? base64ToBytes(item.base64) : encoder.encode(item.text ?? ''),
      mtimeMs: DEMO_FILE_MTIME,
    })
  }
  return tree
}

/**
 * 演示用 Agent 候选集（与上面 `sessions` 里的 `agentId` / `agentName` 一致）。
 *
 * 两个 Agent 故意配**不同的默认模型 / 默认目录**：手机端切换 Agent 时能看出联动，
 * 也能验证「不传模型 / 目录 = 用所选 Agent 的默认值」这条语义。
 */
const DEMO_AGENTS: AgentOptionDTO[] = [
  {
    id: 'agent-virlen',
    name: 'Virlen',
    defaultModel: { providerConfigId: 'p-openai', modelId: 'gpt-4o' },
    defaultWorkspace: DEMO_WORKSPACES[0],
  },
  {
    id: 'agent-reviewer',
    name: '代码评审员',
    defaultModel: { providerConfigId: 'p-anthropic', modelId: 'claude-sonnet-4' },
    defaultWorkspace: DEMO_WORKSPACES[1],
  },
]

/**
 * 「只引用了消息、没写正文」时电脑侧补的那句话。
 *
 * 与桌面输入框的兜底**同一条**（`utils/messageContent.ts::buildUserContent` 的「有引用无文本」分支）：
 * 不变的话，用例会对着一个与真机不同的正文发绿灯。文案取桌面的中文原文 ——
 * 桌面切成英文时会是另一句，但 mock 只求**行为同形**，不求与 i18n 逐字同步
 * （真要与 i18n 一致，那是 virlen-app 侧的跨端用例该盯的事）。
 */
const QUOTE_ONLY_TEXT = '请针对引用的消息回复'
/** 只带文件、不写正文时的兜底正文（与电脑侧 `buildUserContent` 的「看看这些文件」同义）。 */
const FILE_ONLY_TEXT = '看看这些文件'

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
        /*
         * 入参摘要与真实电脑侧**同源**（`summarizeToolArgs`）：演示宿主不手写一行
         * 会与真实格式化规则打架的假数据 —— 那种假数据会让联调时看到的现象失去意义。
         */
        toolArgs: summarizeToolArgs('list_files', { path: 'src' }),
        /*
         * 展开区的完整入参同样**同源**（`formatToolArgs`）：演示宿主手写一段会在形态上
         * 与真实电脑侧打架（缩进 / 路径缩不缩短），那会让联调时看到的现象失去意义。
         */
        toolArgsFull: formatToolArgs({ path: 'src' }),
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

  /**
   * 待应答交互（模拟电脑侧的交互注册表）。
   */
  const interactions = new Map<string, InteractionDTO>()

  /**
   * 手机在 `hello` 里声明的流式偏好（§32）。默认 `full` —— 不声明就按整帧发，
   * 与真实电脑侧同一条规则（旧客户端收到增量帧会把一帧当全文，正文就错位了）。
   */
  let peerStreamMode: StreamMode = 'full'

  /** 被「暂存」而暂停的会话（模拟电脑侧的 paused 运行态，供 resume 演示 / 测试）。 */
  const pausedSessions = new Set<string>()

  function emitList(): void {
    emit?.('host.event.session.list.changed', { sessions: sessions.map((s) => ({ ...s })) })
  }

  /**
   * 发一帧流式正文（按客户端的 `streamMode` 声明决定整帧还是增量）。
   *
   * `sent` = 上一步**已发出**的正文；首帧传 `''` → 必然走 `full`（客户端还没有基准）。
   * 与真实电脑侧一样：写改（非前缀增长）时回落整帧，而不是硬发一个错的增量。
   */
  function emitStreamFrame(
    sessionId: string,
    messageId: string,
    seq: number,
    text: string,
    sent: string,
  ): void {
    const delta = peerStreamMode === 'delta' && sent !== '' && text.startsWith(sent)
    emitFor(sessionId, 'host.event.message.stream', {
      sessionId,
      messageId,
      seq,
      mode: delta ? 'delta' : 'full',
      text: delta ? text.slice(sent.length) : text,
      ...(delta ? { offset: sent.length } : {}),
      final: false,
    })
  }

  async function streamReply(sessionId: string, list: MessageDTO[]): Promise<void> {
    const messageId = nextId('a')
    let text = ''
    // 模拟生成过程中的积压：内容真实增长 → 流式帧逐次变长（与真实电脑侧同规则）
    list.push({ id: messageId, role: 'assistant', text: '', createdAt: Date.now() })
    for (let i = 0; i < streamSteps; i++) {
      await delay(streamDelayMs)
      const sent = text
      text += `这是模拟流式的第 ${i + 1} 段。`
      emitStreamFrame(sessionId, messageId, i + 1, text, sent)
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
    // 收尾帧同样是**整段**（定稿全文可能被回填/修复改写，增量已经不可靠）
    emitFor(sessionId, 'host.event.message.stream', {
      sessionId,
      messageId,
      seq: streamSteps + 1,
      mode: 'full',
      text,
      final: true,
    })
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

  /** 推一次「正在执行中的工具」（`RuntimeDTO.runningTools`）—— 同上，受订阅门约束。 */
  function setRunningTools(sessionId: string, tools: RunningToolDTO[] | null): void {
    if (tools === null) {
      // 跑完了：没有执行中的工具，也不再工作（真机上这一步之后要么空闲、要么出新消息）
      emitFor(sessionId, 'host.event.session.runtime.changed', {
        sessionId,
        runtime: { working: false },
      })
      return
    }
    emitFor(sessionId, 'host.event.session.runtime.changed', {
      sessionId,
      // 工具在执行 → 一定是 working；空数组即「都执行完了，但本轮还没结束」
      runtime: { working: true, ...(tools.length > 0 ? { runningTools: tools } : {}) },
    })
  }

  function contextOf(sessionId: string): ContextInfoDTO {
    const tokens = contextTokens.get(sessionId)
    return {
      tokens: tokens ?? null,
      windowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    }
  }

  /* ───────────────────── §37：演示文件树（手机端文件浏览 / 上传） ───────────────────── */

  /** 各工作目录一份演示文件树（懒建：没碰过就没有）。 */
  const trees = new Map<string, Map<string, MockFile>>()

  function treeOf(sessionId: string): Map<string, MockFile> {
    const workspace = sessions.find((s) => s.id === sessionId)?.workspace
    if (!workspace) throw new BridgeError('E_NOT_FOUND', `session not found: ${sessionId}`)
    let tree = trees.get(workspace)
    if (!tree) {
      tree = createDemoTree()
      trees.set(workspace, tree)
    }
    return tree
  }

  /**
   * 单调递增的修改时刻。
   *
   * 不用裸 `Date.now()`：同毫秒内的两次保存会拿到**相同**的 mtime，冲突就检不出来 ——
   * 而「连续存两次」正是这条路径最常见的用法。
   */
  let mtimeSeq = 0
  function nowMtime(): number {
    mtimeSeq = Math.max(Date.now(), mtimeSeq + 1)
    return mtimeSeq
  }

  /**
   * 非中继门槛 —— **与真实电脑侧同一句文案**（`fileTransferDeniedReason`），
   * 差别只在模拟开关：`MockHostOptions.fileLinkKind`。
   */
  function assertFileLinkUsable(): void {
    const reason = fileTransferDeniedReason(options.fileLinkKind ?? 'direct')
    if (reason) throw new BridgeError('E_DENIED', reason)
  }

  /** 目录是否存在（目录由路径前缀隐式推出；根目录恒存在）。 */
  function dirExists(tree: Map<string, MockFile>, relPath: string): boolean {
    if (!relPath) return true
    const prefix = `${relPath}/`
    for (const key of tree.keys()) if (key.startsWith(prefix)) return true
    return false
  }

  /** 把扁平的文件表按当前层拆成条目（目录在前、按名排序，超过上限即截断）。 */
  function entriesOf(tree: Map<string, MockFile>, relPath: string): { entries: FileEntryDTO[]; truncated: boolean } {
    const prefix = relPath ? `${relPath}/` : ''
    const byName = new Map<string, FileEntryDTO>()
    for (const [path, file] of tree) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash < 0) {
        byName.set(rest, { name: rest, isDir: false, size: file.bytes.length, mtimeMs: file.mtimeMs })
      } else {
        const dir = rest.slice(0, slash)
        if (!byName.has(dir)) byName.set(dir, { name: dir, isDir: true, size: 0, mtimeMs: DEMO_FILE_MTIME })
      }
    }
    const all = [...byName.values()].sort(compareFileEntries)
    return { entries: all.slice(0, FILE_LIST_MAX_ENTRIES), truncated: all.length > FILE_LIST_MAX_ENTRIES }
  }

  interface MockUpload {
    sessionId: string
    dir: string
    name: string
    relPath: string
    bytes: Uint8Array
    received: number
    /** `true` = 覆写已有文件（编辑保存）；缺省 = 上传新建。 */
    overwrite?: boolean
  }

  const uploads = new Map<string, MockUpload>()

  /** 最后一次真正执行的压缩（见 `MockHostDataSource.lastCompress`）。 */
  let lastCompress: { sessionId: string; mode: CompressMode } | null = null

  function requireUpload(uploadId: string): MockUpload {
    const upload = uploads.get(uploadId)
    if (!upload) throw new BridgeError('E_NOT_FOUND', `上传任务不存在或已结束：${uploadId}`)
    return upload
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
      // §32：记下手机声明的流式偏好（后续 `message.stream` 按它决定整帧/增量）
      peerStreamMode = params.streamMode === 'delta' ? 'delta' : 'full'
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
          // 压缩方式（§22）：mock 真的按 `CompressParams.mode` 出不同产物，故如实声明 ——
          // 不声明的话手机端只会渲染一个「压缩上下文」按钮，用例就测不到选择器那条路
          COMPRESS_MODE_CAPABILITY,
          // Agent 选择：mock 确实按候选集校验 agentId（见 createSession），故如实声明 ——
          // 不声明的话手机端会隐藏选择器，用例就测不到真实链路
          SESSION_AGENT_CAPABILITY,
          // 消息级操作：mock 确实实现了这两项（引用进内容块 / 截断删除），故如实声明 ——
          // 不声明的话手机端会隐藏入口，用例就测不到真实链路
          MESSAGE_QUOTE_CAPABILITY,
          MESSAGE_DELETE_CAPABILITY,
          // 文件引用（`SendParams.files`）：mock 真的做两步 —— 校验归一（`sanitizeFileRefs`，
          // 与真电脑侧同一份）与「文件块不进 `text`」的投影规则 —— 故如实声明
          MESSAGE_FILE_CAPABILITY,
          // §37：文件四档 —— mock 真的按这四档实现了（列 / 读 / 写 / 覆写），故如实声明
          FILE_BROWSE_CAPABILITY,
          FILE_DOWNLOAD_CAPABILITY,
          FILE_UPLOAD_CAPABILITY,
          // 覆写已有文件（编辑保存）：mock 真的按「目标必须存在 + mtime/size 校验 + 不改名」
          // 实现了，故如实声明 —— 不声明的话手机端只会给只读预览，用例就测不到编辑那条路
          FILE_EDIT_CAPABILITY,
          // 窗口两阶段加载（`MsgPageParams.detail`）：mock 真的按 `detail:'summary'` 省掉两类
          // 重字段（工具输出 / 完整入参）并打 `deferred`，故如实声明 ——
          // 不声明的话手机端不会走两阶段，用例就测不到这条真实链路
          MESSAGES_DETAIL_CAPABILITY,
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
      /*
       * 两阶段加载（`detail:'summary'`）：与真电脑侧**同一口径** —— 省掉两类重字段
       * （工具执行输出 `text`、完整入参 `toolArgsFull`），并在受影响的条目上打 `deferred`。
       * mock 若不实现，手机端的「先摘要后补细节」路径就永远测不到（对着假行为发绿灯）。
       */
      const summary = params.detail === 'summary'
      const project = (m: MessageDTO): MessageDTO => {
        if (!summary) return { ...m }
        const toolText = m.role === 'tool' && m.text.trim().length > 0
        const hasArgsFull = m.toolArgsFull != null
        if (!toolText && !hasArgsFull) return { ...m }
        const out: MessageDTO = { ...m, deferred: true }
        if (toolText) out.text = ''
        if (hasArgsFull) delete out.toolArgsFull
        return out
      }
      // 游标 = 已返回窗口中最旧一条的下标（与真实电脑侧的 rowid 同形：不透明、原样回传）
      if (params.fromRowid != null) {
        const end = Math.max(0, Math.min(params.fromRowid, list.length))
        const start = Math.max(0, end - limit)
        return {
          messages: list.slice(start, end).map(project),
          hasMore: start > 0,
          cursor: start > 0 ? start : null,
        }
      }
      const start = Math.max(0, list.length - limit)
      return {
        messages: list.slice(start).map(project),
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
      const quotes = params.quotes ?? []
      /*
       * 文件引用（§37 的延伸）：与真电脑侧**同一个校验口径**（`sanitizeFileRefs`）——
       * 形状非法 / 超上限 → `E_BAD_REQUEST` 拒整条。mock 若比真机宽松（比如照单全收），
       * 手机端侧的处理分支就永远测不到，真机上才表现为「发了但什么都没发生」。
       */
      const sanitized = sanitizeFileRefs(params.files)
      if (!sanitized.ok) {
        throw new BridgeError('E_BAD_REQUEST', sanitized.reason)
      }
      const files = sanitized.files
      const userMessage: MessageDTO = {
        id: nextId('u'),
        role: 'user',
        // 与真实电脑侧的白名单投影同一条规则：引用与文件都**不进 `text`**
        // （引用走 `quotes`、文件走 `files`），否则客户端会各显示两遍
        // （引用条 / 文件 chip + 正文里的 `[引用] …` / `[文件] …`）
        text: params.text || (quotes.length > 0 ? QUOTE_ONLY_TEXT : files.length > 0 ? FILE_ONLY_TEXT : ''),
        createdAt: Date.now(),
        ...(quotes.length > 0 ? { quotes: quotes.map((q) => ({ ...q })) } : {}),
        // 无文件则整个字段不带（与 `quotes` 同一条纪律：不为旧手机端凭空多出一个空数组）
        ...(files.length > 0 ? { files: files.map((f) => ({ ...f })) } : {}),
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
      /**
       * Agent：**与真实电脑侧同一条防线** —— id 必须来自 `host.agent.list` 的候选集，
       * 手机不能自造（未知 id 即 `E_BAD_REQUEST`）。不传 = 默认 Agent。
       */
      const agent =
        params.agentId != null ? DEMO_AGENTS.find((a) => a.id === params.agentId) : undefined
      if (params.agentId != null && !agent) {
        throw new BridgeError('E_BAD_REQUEST', `Agent 不存在：${params.agentId}`)
      }
      // 模型：手机没给就用**所选 Agent** 的默认模型（与真实电脑侧 createSession 同序）
      const model = resolveModel(
        params.providerConfigId ?? agent?.defaultModel?.providerConfigId,
        params.modelId ?? agent?.defaultModel?.modelId,
      )
      sessions.unshift({
        id,
        title: params.title || '手机新建的会话',
        updatedAt: Date.now(),
        working: false,
        agentId: agent?.id ?? 'agent-virlen',
        agentName: agent?.name ?? 'Virlen',
        workspace: workspace ?? agent?.defaultWorkspace ?? DEMO_WORKSPACES[0],
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
    /**
     * 删除单条消息及其之后的全部消息（截断）—— **与真实电脑侧同一条规则**：
     * confirm 必填 / 回复中拒绝（E_BUSY）/ tool 消息不可删 / 删完推 `messages.reset`。
     *
     * ⚠️ mock 偏宽松 = 用例对着假行为发绿灯（§18.6 的教训），故三道闸一道不少。
     */
    async deleteMessage(params: DeleteMessageParams) {
      calls.push('host.session.message.delete')
      if (params.confirm !== true) {
        throw new BridgeError('E_CONFIRM_REQUIRED', '删除消息需二次确认（confirm:true）')
      }
      const list = messages.get(params.sessionId)
      if (!list) throw new BridgeError('E_NOT_FOUND', `session not found: ${params.sessionId}`)
      const session = sessions.find((s) => s.id === params.sessionId)
      if (session?.working === true) {
        throw new BridgeError('E_BUSY', '该会话正在回复中，请稍后再试')
      }
      const idx = list.findIndex((m) => m.id === params.messageId)
      if (idx === -1) throw new BridgeError('E_NOT_FOUND', `message not found: ${params.messageId}`)
      if (list[idx].role === 'tool') {
        throw new BridgeError('E_BAD_REQUEST', '工具消息不能单独删除')
      }
      // 本条及其后全部删除，并推 `messages.reset` 让客户端重拉窗口
      list.splice(idx)
      if (session) session.updatedAt = Date.now()
      emitFor(params.sessionId, 'host.event.session.messages.reset', { sessionId: params.sessionId })
      bumpContext(params.sessionId, Math.max(0, (contextTokens.get(params.sessionId) ?? 0) - 1_000))
      return { ok: true as const }
    },
    // ── §22：模型 / Agent / 工作目录 / 上下文 ──
    async listModels() {
      calls.push('host.model.list')
      return DEMO_PROVIDERS.map((p) => ({ ...p, models: [...p.models] }))
    },
    async listAgents(): Promise<AgentOptionDTO[]> {
      calls.push('host.agent.list')
      return DEMO_AGENTS.map((a) => ({
        ...a,
        ...(a.defaultModel ? { defaultModel: { ...a.defaultModel } } : {}),
      }))
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
     * 压缩上下文：**与真实电脑侧同判据**（confirm + 最小占用比例 + 方式可辨认），
     * 然后把消息换成一条 summary，并推 `messages.reset`（手机重拉窗口）。
     *
     * `mode` 不同则产物不同（`ai` 是一句摘要口吻、`raw` 是「历史已重排为文本」）——
     * 两种方式的差别在真机上恰恰就是产物形态，mock 若给同一句文本，两条支路就分不开。
     */
    async compress(params: CompressParams) {
      calls.push('host.session.compress')
      if (params.confirm !== true) {
        throw new BridgeError('E_CONFIRM_REQUIRED', '压缩上下文需二次确认（confirm:true）')
      }
      // 没传 = 用缺省（真实电脑侧是「设置里的 contextCompressMode」）；传了但不认识 → 拒
      const mode = params.mode == null ? DEFAULT_COMPRESS_MODE : compressModeOf(params.mode)
      if (!mode) {
        throw new BridgeError('E_BAD_REQUEST', `未知的压缩方式: ${String(params.mode)}`)
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
        text:
          mode === 'raw'
            ? '[上下文摘要] 正文压缩：整段历史已本地渲染为一段文本（正文一字未删）。'
            : '[上下文摘要] 之前的内容已压缩为摘要。',
        createdAt: Date.now(),
      }
      lastCompress = { sessionId: params.sessionId, mode }
      messages.set(params.sessionId, [summary])
      emitFor(params.sessionId, 'host.event.session.messages.reset', { sessionId: params.sessionId })
      emitFor(params.sessionId, 'host.event.message.added', { sessionId: params.sessionId, message: summary })
      bumpContext(params.sessionId, 2_000)
      return { ok: true as const }
    },
    /** 手动推一次占用变化（harness 按钮 / 测试用）。 */
    bumpContext,
    setToolProgress,
    setRunningTools,

    // ── §37：工作目录文件（与真实电脑侧同几条纪律：非中继拒 / 分块 / 临时态不落盘）──
    async listFiles(params: FileListParams): Promise<FileListResult> {
      calls.push('host.file.list')
      assertFileLinkUsable()
      const tree = treeOf(params.sessionId)
      const relPath = normalizeRelPath(params.path ?? '')
      if (!dirExists(tree, relPath)) {
        throw new BridgeError('E_NOT_FOUND', `目录不存在：${relPath || '/'}`)
      }
      const { entries, truncated } = entriesOf(tree, relPath)
      const workspace = sessions.find((s) => s.id === params.sessionId)?.workspace ?? ''
      return {
        relPath,
        absPath: relPath ? `${workspace}/${relPath}` : workspace,
        entries,
        ...(truncated ? { truncated: true } : {}),
      }
    },
    async readFile(params: FileReadParams): Promise<FileReadResult> {
      calls.push('host.file.read')
      assertFileLinkUsable()
      const relPath = normalizeRelPath(params.path)
      const file = treeOf(params.sessionId).get(relPath)
      if (!file) throw new BridgeError('E_NOT_FOUND', `文件不存在：${relPath}`)
      const bytes = file.bytes
      const offset = Math.max(0, Math.floor(params.offset ?? 0))
      const want = Math.max(1, Math.floor(params.length ?? FILE_CHUNK_BYTES))
      const slice = bytes.subarray(offset, offset + Math.min(want, FILE_CHUNK_BYTES))
      const name = baseNameOfPath(relPath)
      return {
        data: bytesToBase64(slice),
        offset,
        size: bytes.length,
        eof: offset + slice.length >= bytes.length,
        kind: previewKindOf(name),
        mime: mimeTypeOf(name),
        // 编辑保存的冲突校验靠它（手机端打开时记下、保存时回传）
        mtimeMs: file.mtimeMs,
      }
    },
    async beginFileWrite(params: FileWriteBeginParams): Promise<FileWriteBeginResult> {
      calls.push('host.file.write.begin')
      assertFileLinkUsable()
      const tree = treeOf(params.sessionId)
      const dir = normalizeRelPath(params.dir ?? '')
      const target = (n: string): string => (dir ? `${dir}/${n}` : n)
      if (!isSafeEntryName(params.name)) {
        throw new BridgeError('E_BAD_REQUEST', `文件名不合法：${params.name}`)
      }
      if (!Number.isFinite(params.size) || params.size < 0) {
        throw new BridgeError('E_BAD_REQUEST', '文件大小非法')
      }
      // 超限在**开始前**就拒（而不是传到一半才说）—— 这是 u91cf 级纪律，与真实电脑侧同一条
      if (params.size > FILE_UPLOAD_MAX_BYTES) {
        throw new BridgeError('E_BAD_REQUEST', `文件超过上限（${formatFileSize(FILE_UPLOAD_MAX_BYTES)}）`)
      }
      if (!dirExists(tree, dir)) throw new BridgeError('E_NOT_FOUND', `目录不存在：${dir || '/'}`)
      /*
       * ── 覆写（编辑保存）：与上传是**两条不同的路** ──
       * 这里的每一条都与真实电脑侧逐条对齐（否则手机端用例在 mock 上跑出来的行为不算数）：
       * 目标必须已存在、只收可编辑的扩展名、按编辑上限夹一次、mtime/size 不符即冲突。
       */
      if (params.overwrite) {
        const existing = tree.get(target(params.name))
        if (!existing) {
          throw new BridgeError('E_NOT_FOUND', `文件不存在：${target(params.name)}`)
        }
        if (!isEditableFileName(params.name)) {
          throw new BridgeError('E_BAD_REQUEST', `这类文件不支持编辑：${params.name}`)
        }
        if (params.size > FILE_EDIT_MAX_BYTES) {
          throw new BridgeError(
            'E_BAD_REQUEST',
            `文件超过编辑上限（${formatFileSize(FILE_EDIT_MAX_BYTES)}）`,
          )
        }
        if (params.expectMtimeMs != null && params.expectMtimeMs !== existing.mtimeMs) {
          throw new BridgeError('E_CONFLICT', '电脑上的这份文件已经变了，请重新载入')
        }
        if (params.expectSize != null && params.expectSize !== existing.bytes.length) {
          throw new BridgeError('E_CONFLICT', '电脑上的这份文件已经变了，请重新载入')
        }
        const editId = nextId('up')
        uploads.set(editId, {
          sessionId: params.sessionId,
          dir,
          name: params.name,
          relPath: target(params.name),
          bytes: new Uint8Array(params.size),
          received: 0,
          overwrite: true,
        })
        return { uploadId: editId, name: params.name, relPath: target(params.name), received: 0 }
      }
      let name = params.name
      if (tree.has(target(name))) {
        if ((params.onConflict ?? 'rename') === 'reject') {
          throw new BridgeError('E_CONFLICT', `同名文件已存在：${name}`)
        }
        let index = 1
        for (; index <= 100; index++) {
          const candidate = duplicateNameCandidate(params.name, index)
          if (!tree.has(target(candidate))) {
            name = candidate
            break
          }
        }
        if (index > 100) throw new BridgeError('E_CONFLICT', '同名文件过多，无法自动改名')
      }
      const uploadId = nextId('up')
      uploads.set(uploadId, {
        sessionId: params.sessionId,
        dir,
        name,
        relPath: target(name),
        bytes: new Uint8Array(params.size),
        received: 0,
      })
      return { uploadId, name, relPath: target(name), received: 0 }
    },
    async writeFileChunk(params: FileWriteChunkParams): Promise<FileWriteChunkResult> {
      calls.push('host.file.write.chunk')
      assertFileLinkUsable()
      const upload = requireUpload(params.uploadId)
      // 乱序即拒：拼接错位得到的是一份「看起来成功了」的坏文件，比报错难查得多
      if (params.offset !== upload.received) {
        throw new BridgeError('E_CONFLICT', `分块偏移不对：期望 ${upload.received}，收到 ${params.offset}`)
      }
      const chunk = base64ToBytes(params.data)
      if (upload.received + chunk.length > upload.bytes.length) {
        throw new BridgeError('E_BAD_REQUEST', '写入字节数超过申报的文件大小')
      }
      upload.bytes.set(chunk, upload.received)
      upload.received += chunk.length
      return { received: upload.received }
    },
    async finishFileWrite(params: FileWriteFinishParams): Promise<FileWriteFinishResult> {
      calls.push('host.file.write.finish')
      assertFileLinkUsable()
      const upload = requireUpload(params.uploadId)
      // 字节数不符就不落盘：申报 1MB 只收到 300KB 时，用户在电脑上得到的是一份坏文件
      if (upload.received !== upload.bytes.length) {
        throw new BridgeError('E_BAD_REQUEST', `文件未传完：${upload.received}/${upload.bytes.length}`)
      }
      uploads.delete(params.uploadId)
      // 写盘即换 mtime（编辑保存的冲突校验靠它）
      const mtimeMs = nowMtime()
      treeOf(upload.sessionId).set(upload.relPath, { bytes: upload.bytes, mtimeMs })
      // 覆写与上传的收尾差别只有一句注释那么大：**同一个 relPath**，不做冲突改名
      return { name: upload.name, relPath: upload.relPath, size: upload.bytes.length, mtimeMs }
    },
    /**
     * 放弃上传：**不过非中继门槛**（只删自己的临时态）。
     *
     * 为何例外：上传开始后链路可能刚好被换成中继（或断了），而那时用户/手机端恰恰最需要
     * 把临时文件清掉。在一个只做清理的动作上又加一道链路门，只会把临时文件永久留在用户项目里。
     */
    async abortFileWrite(params: FileWriteAbortParams) {
      calls.push('host.file.write.abort')
      uploads.delete(params.uploadId)
      return { ok: true as const }
    },
    /** 测试 / harness：直接读演示文件树里的一个文件（`null` = 不存在）。 */
    readMockFile(sessionId, relPath) {
      const file = treeOf(sessionId).get(normalizeRelPath(relPath))
      return file ? file.bytes.slice() : null
    },
    /** 测试 / harness：往演示文件树里放一个文件（目录隐式创建）——模拟「电脑上有人改了它」。 */
    writeMockFile(sessionId, relPath, content) {
      const data = typeof content === 'string' ? new TextEncoder().encode(content) : content
      treeOf(sessionId).set(normalizeRelPath(relPath), { bytes: data, mtimeMs: nowMtime() })
    },
    /** 测试 / harness：当前文件树里的全部相对路径（排序后）。 */
    listMockFiles(sessionId) {
      return [...treeOf(sessionId).keys()].sort()
    },
    /** 测试 / harness：最后一次真正执行的压缩（含**实际生效的方式**）。 */
    lastCompress() {
      return lastCompress
    },
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
