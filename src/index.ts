/**
 * virlen-remote —— 手机控制协议栈共享包
 *
 * 电脑端（virlen-app）与手机端（virlen-mobile）共用同一份实现
 * （见 docs/phone-control-bridge.md §1「越往下越同构」、§6「共享包」）。
 *
 * 分层：
 *   protocol/   与传输无关的逻辑（帧 / RPC / 错误 / 能力协商 / 方法表）
 *   transport/  字节通道抽象 + 内存实现（RTC 实现属 M3）
 *
 * **零运行时依赖**：WebRTC 用浏览器原生 `RTCPeerConnection`；Node 侧只用 memory transport 做测试。
 */

// ── protocol ──
export { PROTOCOL_VERSION, HEADER_SIZE, DEFAULT_MAX_FRAME_PAYLOAD, FrameKind } from './protocol/frame'
export { encodeHeader, decodeHeader, frameBody, encodeFrames, Reassembler } from './protocol/frame'
export type { FrameHeader, DecodedMessage } from './protocol/frame'

export { BridgeError, toBridgeError } from './protocol/errors'
export type { ErrorCode, WireError, BridgeErrorOptions } from './protocol/errors'

export { newRequestId } from './protocol/ids'

// ── 设备身份与授权凭证（M6，§30）──
export {
  HOST_KEY_PREFIX,
  MOBILE_KEY_PREFIX,
  GRANT_PREFIX,
  ROOM_PREFIX,
  GRANT_TTL_MS,
  GRANT_MAX_LIFETIME_MS,
  randomKey,
  newDeviceKey,
  newGrantToken,
  isDeviceKey,
  roomFor,
  hostKeyFromRoom,
  issueGrant,
  isGrantExpired,
  renewGrant,
  checkGrant,
  describeGrantRemaining,
} from './protocol/identity'
export type { DeviceKind, GrantRecord, CredentialRejectReason, RoomStatus } from './protocol/identity'

// ── 配对载荷（二维码内容，两端同一份）──
export {
  PAIRING_PAYLOAD_VERSION,
  PAIRING_TICKET_TTL_MS,
  PAIRING_OBFUSCATION_PREFIX,
  PAIRING_URL_BASE,
  PAIRING_URL_PARAM,
  buildPairingPayload,
  encodePairingPayload,
  buildPairingUrl,
  parsePairingPayload,
  roomOfPayload,
} from './protocol/pairing'
export type { PairingPayload } from './protocol/pairing'

export { normalizeChoiceAnswer, answerActionError, CHOICE_JOINER } from './protocol/answer'
export type { ChoiceAnswer } from './protocol/answer'

export { negotiate, intersectCapabilities } from './protocol/hello'

// ── 消息级操作（引用 / 删除）的共用契约：能力名 + 引用快照体 ──
export { MESSAGE_QUOTE_CAPABILITY, MESSAGE_DELETE_CAPABILITY } from './protocol/message-actions'
export type { MessageQuote } from './protocol/message-actions'

// ── Agent 相关能力名（新建会话时选定 Agent 的授权口径）──
export { SESSION_AGENT_CAPABILITY } from './protocol/agents'

// ── 工具入参的两种呈现（折叠态一行摘要 / 展开态完整入参）的唯一格式化口径 ──
export {
  summarizeToolArgs,
  formatToolArgs,
  elideMiddle,
  TOOL_ARGS_MAX,
  TOOL_DETAIL_MAX,
} from './protocol/tool-args'
export type { ToolArgsSummaryOptions, ToolArgsFormatOptions } from './protocol/tool-args'

export { Endpoint } from './protocol/endpoint'
export type {
  CallContext,
  EventContext,
  RpcHandler,
  EventSubscriber,
  CallOptions,
  EndpointOptions,
} from './protocol/endpoint'

export { createCaller, createSubscriber, registerHandlers } from './protocol/api'
export { DEFAULT_CONTEXT_WINDOW_TOKENS, COMPRESS_MIN_RATIO } from './protocol/api'
export type {
  ParamsOf,
  ResultOf,
  TypedCaller,
  TypedSubscriber,
  HandlerImpl,
  HostApi,
  MobileApi,
  HostEvents,
  MobileEvents,
  SessionSummaryDTO,
  MessageDTO,
  RuntimeDTO,
  RunningToolDTO,
  InteractionDTO,
  InteractionOutcome,
  StreamMode,
  ApprovalTier,
  SendParams,
  MsgPageParams,
  MsgPageDTO,
  AnswerParams,
  AnswerAction,
  AnswerResult,
  AnswerRejectReason,
  CreateSessionParams,
  RenameSessionParams,
  PinSessionParams,
  DeleteSessionParams,
  DeleteMessageParams,
  AgentOptionDTO,
  ModelProviderDTO,
  WorkspaceOptionDTO,
  ContextInfoDTO,
  SetModelParams,
  ContextParams,
  CompressParams,
} from './protocol/api'
export type { HelloParams, HelloResult, ClientInfo, NegotiationInput, Negotiated } from './protocol/hello'

export { registerHostHandlers } from './protocol/host'
export type { HostDataSource, HostEmit, HostRegistration, RegisterHostOptions } from './protocol/host'
// ── transport ──
export type { Transport, TransportState } from './transport/types'
export { MemoryTransport, createMemoryPair } from './transport/memory'
export type { MemoryTransportMetrics } from './transport/memory'
export { BroadcastTransport, createBroadcastPair } from './transport/broadcast'
export { SseSignalingClient, fetchRoomStatus, fetchHostOnlineMap } from './transport/signaling'
export type {
  SignalingChannel,
  SignalingRole,
  SseSignalingOptions,
  EventSourceLike,
  KickedInfo,
  FetchRoomStatusOptions,
} from './transport/signaling'
export { RtcTransport } from './transport/rtc'
export type { RtcTransportOptions } from './transport/rtc'

// ── RTC 链路类型判定（直连 / 中继，两端同一份口径）──
export {
  LINK_KIND_POLL_MS,
  classifyLinkKind,
  probeLinkKind,
  pickCandidatePair,
  findCandidate,
  LinkKindWatcher,
} from './transport/link-kind'
export type {
  LinkKind,
  LinkStatsEntry,
  StatsReportLike,
  StatsProvider,
} from './transport/link-kind'

// ── 传输档位（链路类型 → 发不发详细内容，两端同一份口径）──
export { MESSAGE_DETAIL_CAPABILITY, transferTierOf } from './transport/transfer-tier'
export type { TransferTier } from './transport/transfer-tier'

// ── ICE 配置（M7，§31）：客户端不再内置任何 TURN 凭证 ──
export {
  ICE_CONFIG_VERSION,
  ICE_API_PATH,
  ICE_CUSTOM_STORAGE_KEY,
  ICE_REMOTE_STORAGE_KEY,
  ICE_CACHE_TTL_MS,
  ICE_FETCH_TIMEOUT_MS,
  sanitizeIceServers,
  parseIceText,
  formatIceServers,
  describeIceSource,
  fetchIceServers,
  resolveIceServers,
  readCustomIceText,
  writeCustomIceText,
} from './transport/ice'
export type {
  IceServerInit,
  IceSource,
  IceStoragePort,
  ResolvedIceServers,
  ParseIceResult,
  FetchIceOptions,
  ResolveIceOptions,
} from './transport/ice'
