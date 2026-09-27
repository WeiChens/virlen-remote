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
  AnswerParams,
  AnswerResult,
  CompressParams,
  ContextInfoDTO,
  ContextParams,
  CreateSessionParams,
  DeleteSessionParams,
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
  /** 可选：覆盖默认 hello 应答。 */
  hello?(params: HelloParams): HelloResult | Promise<HelloResult>
  // ── §22：模型 / 工作目录 / 上下文 ──
  /** 已启用的模型服务与模型（白名单：不含 apiKey / baseUrl）。 */
  listModels(): ModelProviderDTO[] | Promise<ModelProviderDTO[]>
  /** 切换会话模型；实现侧必须校验「服务已启用且模型存在」。 */
  setModel(params: SetModelParams): { ok: true } | Promise<{ ok: true }>
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
  on('host.interaction.answer', async (params) => source.answer(params as AnswerParams))
  on('host.interaction.list', async () => ({ interactions: await source.listInteractions() }))
  // ── §22：模型 / 工作目录 / 上下文 ──
  on('host.model.list', async () => ({ providers: await source.listModels() }))
  on('host.session.setModel', async (params) => source.setModel(params as SetModelParams))
  on('host.workspace.list', async () => ({ workspaces: await source.listWorkspaces() }))
  on('host.session.context', async (params) => source.getContext(params as ContextParams))
  on('host.session.compress', async (params) => source.compress(params as CompressParams))

  return {
    emit,
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }
}
