/**
 * Host 侧通用胶水（电脑端「接口层」的与传输无关的部分）。
 *
 * 设计：**把「方法分发」与「数据来源」解耦**，用 `HostDataSource` 端口隔离。
 * 于是同一份 bridge 代码有两个数据源实现：
 *   - 真实：`virlen-app/src/bridge/`，接 `sessionStore` / `chat-service`（含 ACL / 审计）
 *   - 演示/测试：mock 数据源（`virlen-remote/testing`）
 * 这样 M2 的浏览器 harness（mock）与 M3 的真实桌面端（真实源）复用同一分发逻辑，
 * 且 mock 让「不依赖 WebRTC 的端到端联调」成为可能。
 *
 * 事件用 `HostEmit` 回填：host 侧（store-bridge / mock）通过它把 `HostEvents` 推给手机。
 */
import type { Endpoint } from './endpoint'
import type {
  AgentOptionDTO,
  AnswerParams,
  AnswerResult,
  CompressParams,
  ContextInfoDTO,
  ContextParams,
  CreateSessionParams,
  DeleteMessageParams,
  DeleteSessionParams,
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
  HostEvents,
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
} from './api'
import type { ClientInfo, HelloParams, HelloResult } from './hello'

/** 电脑端接口层的数据来源（返回已投影好的 DTO，投影逻辑在实现侧）。 */
export interface HostDataSource {
  listSessions(): SessionSummaryDTO[] | Promise<SessionSummaryDTO[]>
  getMessages(params: MsgPageParams): MsgPageDTO | Promise<MsgPageDTO>
  getMessage(params: { sessionId: string; messageId: string }): MessageDTO | Promise<MessageDTO>
  send(params: SendParams): { messageId: string } | Promise<{ messageId: string }>
  cancel(params: { sessionId: string }): { ok: true } | Promise<{ ok: true }>
  /** 从暂停的 run 快照恢复执行（M5，与手机端「暂存」配对）。 */
  resume(params: { sessionId: string }): { ok: true } | Promise<{ ok: true }>
  subscribe(params: { sessionId: string; fromRowid?: number }): { ok: true } | Promise<{ ok: true }>
  answer(params: AnswerParams): AnswerResult | Promise<AnswerResult>
  /** 当前待应答交互（拉取式；手机每次链路就绪后调一次，补齐错过的 `requested` 事件）。 */
  listInteractions(): InteractionDTO[] | Promise<InteractionDTO[]>
  // ── M4 写操作（§16.1）──
  createSession(params: CreateSessionParams): { sessionId: string } | Promise<{ sessionId: string }>
  renameSession(params: RenameSessionParams): { ok: true } | Promise<{ ok: true }>
  setPinned(params: PinSessionParams): { ok: true } | Promise<{ ok: true }>
  /** ⚠️ 不可逆；实现侧必须校验 `confirm === true`（不得依赖手机 UI）。 */
  deleteSession(params: DeleteSessionParams): { ok: true } | Promise<{ ok: true }>
  /**
   * 删除单条消息及其之后的全部消息（截断）。
   *
   * ⚠️ 实现侧必须自己把三道闸都做上（不得依赖手机 UI）：
   * 1. `confirm === true`（缺则 `E_CONFIRM_REQUIRED`）；
   * 2. 会话**正在回复**时拒（`E_BUSY`）—— 删断正在跑的 run 会留下悬空工具调用；
   * 3. 目标是 `role:'tool'` 的消息时拒（`E_BAD_REQUEST`）—— 工具结果与发起它的
   *    assistant 消息是一体两面，单独删掉只会留下悬空调用。
   *
   * 结果不在应答里回传：实现侧负责推 `host.event.session.messages.reset`，
   * 客户端重拉窗口（与压缩同一条一致性策略）。
   */
  deleteMessage(params: DeleteMessageParams): { ok: true } | Promise<{ ok: true }>
  /** 可选：覆盖默认 hello 应答。 */
  hello?(params: HelloParams): HelloResult | Promise<HelloResult>
  // ── §22：模型 / 工作目录 / 上下文 ──
  /** 已启用的模型服务与模型（白名单：不含 apiKey / baseUrl）。 */
  listModels(): ModelProviderDTO[] | Promise<ModelProviderDTO[]>
  /** 切换会话模型；实现侧必须校验「服务已启用且模型存在」。 */
  setModel(params: SetModelParams): { ok: true } | Promise<{ ok: true }>
  /** 新建会话可选的 Agent 候选集（**只用于新建**，已有会话不可改）。 */
  listAgents(): AgentOptionDTO[] | Promise<AgentOptionDTO[]>
  /** 新建会话可选的工作目录候选集（**只用于新建**，已有会话不可改）。 */
  listWorkspaces(): WorkspaceOptionDTO[] | Promise<WorkspaceOptionDTO[]>
  /** 上下文占用快照（口径与桌面 token 环一致）。 */
  getContext(params: ContextParams): ContextInfoDTO | Promise<ContextInfoDTO>
  /**
   * 压缩上下文（fire-and-forget）。
   *
   * ⚠️ 实现侧必须校验 `confirm === true`（不得依赖手机 UI），并自行保证「正在回复 / 正在压缩」不被并发触发。
   */
  compress(params: CompressParams): { ok: true } | Promise<{ ok: true }>
  // ── §37：工作目录文件 ──
  /**
   * 列目录（实现侧必须自己过安全校验与 ACL）。
   *
   * ⚠️ 实现侧还要自己判「这条链路能不能传文件」（非中继）：那是**链路事实**，
   * 不在本文档层能看到的范围里（见 `TransferTier` / `LinkKind`）。
   */
  listFiles(params: FileListParams): FileListResult | Promise<FileListResult>
  /** 读一个分块（预览与下载同一条路）。 */
  readFile(params: FileReadParams): FileReadResult | Promise<FileReadResult>
  /** 上传：开始（校验 + 定名 + 建临时文件）。 */
  beginFileWrite(params: FileWriteBeginParams): FileWriteBeginResult | Promise<FileWriteBeginResult>
  /** 上传：写一块（偏移必须与已接收字节数一致）。 */
  writeFileChunk(params: FileWriteChunkParams): FileWriteChunkResult | Promise<FileWriteChunkResult>
  /** 上传：收尾（临时文件 → 目标名，原子落盘）。 */
  finishFileWrite(params: FileWriteFinishParams): FileWriteFinishResult | Promise<FileWriteFinishResult>
  /** 上传：放弃（删临时文件）。 */
  abortFileWrite(params: FileWriteAbortParams): { ok: true } | Promise<{ ok: true }>
}

export type HostEmit = <E extends keyof HostEvents & string>(topic: E, payload: HostEvents[E]) => void

export interface HostRegistration {
  /** 把一条 `HostEvents` 推给对端（手机）。 */
  emit: HostEmit
  /** 注销全部 handler 与订阅。 */
  dispose(): void
}

export interface RegisterHostOptions {
  hostInfo?: ClientInfo
  /** 本机声明的能力集（会与手机 hello 的能力取交集，见 hello.ts）。 */
  capabilities?: string[]
  paired?: boolean
  deviceName?: string
}

const DEFAULT_CAPABILITIES = ['session.list', 'session.send', 'interaction.answer', 'stream.delta']

export function registerHostHandlers(
  endpoint: Endpoint,
  source: HostDataSource,
  options: RegisterHostOptions = {},
): HostRegistration {
  const disposers: Array<() => void> = []

  const emit: HostEmit = (topic, payload) => {
    endpoint.emit(topic, payload)
  }

  const on = (method: string, handler: (params: unknown) => unknown | Promise<unknown>) => {
    disposers.push(endpoint.handle(method, handler))
  }

  on('host.hello', async (params) => {
    if (source.hello) return source.hello(params as HelloParams)
    const hello = params as Partial<HelloParams>
    return {
      protocolVersion: hello.protocolVersion ?? 1,
      host: options.hostInfo ?? { platform: 'web-harness', appVersion: '0.0.0' },
      capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
      paired: options.paired ?? true,
      deviceName: options.deviceName ?? 'Virlen 电脑（演示）',
    } satisfies HelloResult
  })

  on('host.session.list', async () => ({ sessions: await source.listSessions() }))
  on('host.session.messages', async (params) => source.getMessages(params as MsgPageParams))
  on('host.session.message.get', async (params) => {
    const p = params as { sessionId: string; messageId: string }
    return { message: await source.getMessage(p) }
  })
  on('host.session.send', async (params) => source.send(params as SendParams))
  on('host.session.cancel', async (params) => source.cancel(params as { sessionId: string }))
  on('host.session.resume', async (params) => source.resume(params as { sessionId: string }))
  on('host.session.subscribe', async (params) => source.subscribe(params as { sessionId: string; fromRowid?: number }))
  on('host.session.create', async (params) => source.createSession(params as CreateSessionParams))
  on('host.session.rename', async (params) => source.renameSession(params as RenameSessionParams))
  on('host.session.pin', async (params) => source.setPinned(params as PinSessionParams))
  on('host.session.delete', async (params) => source.deleteSession(params as DeleteSessionParams))
  on('host.session.message.delete', async (params) => source.deleteMessage(params as DeleteMessageParams))
  on('host.interaction.answer', async (params) => source.answer(params as AnswerParams))
  on('host.interaction.list', async () => ({ interactions: await source.listInteractions() }))
  // ── §22：模型 / Agent / 工作目录 / 上下文 ──
  on('host.model.list', async () => ({ providers: await source.listModels() }))
  on('host.session.setModel', async (params) => source.setModel(params as SetModelParams))
  on('host.agent.list', async () => ({ agents: await source.listAgents() }))
  on('host.workspace.list', async () => ({ workspaces: await source.listWorkspaces() }))
  on('host.session.context', async (params) => source.getContext(params as ContextParams))
  on('host.session.compress', async (params) => source.compress(params as CompressParams))
  // ── §37：工作目录文件 ──
  on('host.file.list', async (params) => source.listFiles(params as FileListParams))
  on('host.file.read', async (params) => source.readFile(params as FileReadParams))
  on('host.file.write.begin', async (params) => source.beginFileWrite(params as FileWriteBeginParams))
  on('host.file.write.chunk', async (params) => source.writeFileChunk(params as FileWriteChunkParams))
  on('host.file.write.finish', async (params) => source.finishFileWrite(params as FileWriteFinishParams))
  on('host.file.write.abort', async (params) => source.abortFileWrite(params as FileWriteAbortParams))

  return {
    emit,
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }
}
