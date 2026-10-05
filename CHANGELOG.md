# 变更记录

本文件记录对外可见的变更（协议 / 导出面 / 行为）。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.6.1] - 2026-10-05

### Added

- **执行中的工具**：`RuntimeDTO.runningTools?: RunningToolDTO[]`（`RunningToolDTO = { toolCallId, name, args? }`）。
  真机反馈：「工具在电脑上有显示（呼吸点卡片），手机上什么都看不到，只有『正在思考』」—— 根因是
  这段状态**只活在电脑侧的界面推导里**（桌面用「assistant 的 `toolCalls[]` 减去已有结果」得出
  pending 卡片），而工具消息只在**执行完之后**才作为消息下行；`toolProgress` 又只管**参数累积期**
  （工具一开始执行就被清掉）。两者中间的那段静默期，手机上没有任何东西可看。
  语义：已声明、尚无同 `toolCallId` 结果消息的调用；**仅 `working === true` 时可能有值**，
  字段缺席 = 此刻没有执行中的工具（旧电脑端永远缺席 → 旧手机端忽略即可，两端都向后兼容）。
  `args` 是一行**摘要**（与 `MessageDTO.toolArgs` 同一格式化口径，`summarizeToolArgs` + 路径缩短），
  **绝不含参数正文**；里面**没有**百分比 / 实时输出 —— 工具的执行输出仍走结果消息。
- `RunningToolDTO`：上面那个数组的元素类型（已从包根导出）。
- 演示宿主新增 `setRunningTools(sessionId, tools | null)`（与 `setToolProgress` 对称），
  供手机端 UI 联调 / 单测手推这一帧（传 `null` = 跑完了，一并收掉 `working`）。

### Notes

- 纯**可选**字段：不加能力名、不改方法表 —— 旧消费方忽略即可（不会因为多了个字段而
  把帧判成非法）；也不需要新版手机端在 `hello` 里声明什么（没有「旧手机端会误解它」的语义：
  它只是一条展示用的状态）。
- 0.6.0 的导出面保持不变（只多了两个类型导出）。

## [0.6.0] - 2026-10-03

### Added

- **工具入参摘要**：`MessageDTO.toolArgs?: string` —— 一行纯文本，回答「这一步到底在干什么」
  （`src/store/chat.ts` / `npm run build` / `在 src 中搜索 sessionError`）。
  此前工具消息只带 `toolName`，手机端看到的是「调了 read_file」，但**不知道看的是哪个文件** ——
  这条信息在桌面端来自 28 个 `getShortText()` 组件，手机是第二个屏幕，同样需要。
  ⚠️ **不是原始入参**：`write_file.content` / `edit_file.edits[].old_string` 可能是整篇文章，
  原样下行就是流量事故；电脑侧只挑关键入参、格式化并截断（硬上限 160 字符）。
  字段缺席（旧电脑端 / 跨页工具调用）时消费方**只显示工具名**，不要用正文反推。
- `summarizeToolArgs(name, input, options?)`：上面那个字段的**唯一格式化口径**（纯函数）。
  键名以 `tool_defs/definitions.json` 为准；`options.shortenPath` 供电脑侧按工作目录缩短路径。
  真实电脑侧（`bridge/dto.ts`）与演示宿主（`testing/mock-host.ts`）共用它，两端不会漂移。
- **展开区的完整入参**：`MessageDTO.toolArgsFull?: string` —— 多行（两空格缩进的 JSON），
  回答用户点开工具卡片时那个问题：「刚才那行摘要没显示完的到底是什么」。
  真机反馈的第二轮是「入参显示不完整」—— `toolArgs` 只挑**主参数**且有 160 字符上限，
  而用户点开看的恰恰是剩下的部分（还有哪些键、`write_file` 写了什么、`edit_file` 的 old/new）。
  ⚠️ 纪律与摘要**反了一面**：摘要「只给摘要、不给原文」，这里允许出现正文 —— 前提是
  **用户主动点开才渲染**，且总量由 `TOOL_DETAIL_MAX` 兜住。折叠态绝不用它。
- `formatToolArgs(input, options?)`：上面那个字段的唯一格式化口径（纯函数）。与
  `summarizeToolArgs` 共用同一个 `options.shortenPath` 回调 —— 同一份路径不能在折叠态与
  展开态显示成两个样子。空入参（`{}` / `[]`）返回 `undefined`（不摆一个没用的 `{}`）。
- `TOOL_DETAIL_MAX`（5000）与 `elideMiddle(text, max?)`：**展开区文本的长度上限与中间省略**。
  超长时头尾都留、挖掉中间（结论常在两头：开头是命令 / 标题，结尾是报错 / 汇总），
  并把 `…（中间省略 N 字符）…` 写进正文 —— 只看长度是看不出被砍过的，这一行才是凭证。
  工具输出（`MessageDTO.text`，`role:'tool'`）与入参详情**共用这条线**。
- **新建会话时选定 Agent**（`CreateSessionParams.agentId`）：手机端可以把新建的会话归属到指定 Agent。
  归属 Agent 决定该会话的 systemPrompt / 工具白名单 / skills / 默认参数，所以电脑侧必须
  **独立校验** `agentId` 是否属于候选集（未知 id 即 `E_BAD_REQUEST`）—— 不依赖手机端不显示入口。
  不传 = 电脑侧默认 Agent（与 0.5.0 的行为完全一致）。
- `host.agent.list` → `{ agents: AgentOptionDTO[] }`：新建会话可选的 Agent 候选集。
  投影只含 `id` / `name` / `defaultModel` / `defaultWorkspace`（**不含** `systemPrompt`，
  它可达数十 KB；也不含 `allowTools` / `skills` / `params` —— 那些是电脑侧本地配置，§7-⑥）。
  默认值**只供展示与联动**：真正的组装仍在电脑侧 `createSession` 里做。
- `AgentOptionDTO`：候选集条目的类型。
- `SESSION_AGENT_CAPABILITY`（`'session.agent'`）：能力名。这条是**权限**而不是功能标记
  （选 Agent 就是换 systemPrompt / 工具白名单），电脑侧 handler 必须 `assert`；
  旧电脑端没有它 → 手机端据此不显示 Agent 选择器。

### Notes

- **向后兼容**：`agentId` 为可选字段，旧消费方忽略即可；但对**新手机端 + 旧电脑端**
  这个组合，`agentId` 会被当作普通未知字段**静默丢掉** —— 所以手机端的入口
  **必须**由 `SESSION_AGENT_CAPABILITY` 挡住，否则用户会以为选中的是「代码评审员」，
  结果电脑侧按默认 Agent 建了会话。
- **已有会话的 Agent 不可改**：换 Agent 就是换 systemPrompt / 工具白名单 / skills，
  历史对话会前后错配（与「工作目录只在新建时确定」同一条理由，§22.3）。
  因此本轮只有「新建时指定」，**没有** `host.session.setAgent`。
- 0.5.0 的导出面保持不变。

## [0.5.0] - 2026-10-02

### Added

- **消息级操作：引用与删除**（手机端长按气泡菜单的三项能力里，需要电脑端配合的两项）。
- `SendParams.quotes?: MessageQuote[]`：发消息时**引用若干条历史消息**。电脑端把它组装成
  `{type:'quote'}` 内容块（与桌面输入框的引用附件走**同一个** `buildUserContent`），
  因此下游语义与桌面完全一致：模型看到结构化引用块、桌面显示引用条并可点击跳回原消息。
  引文是**快照**（`MessageQuote.text`）—— 原消息被删 / 被上下文压缩替换后引文仍完整。
- `MessageDTO.quotes?: MessageQuote[]`：下行方向的结构化引用。
  ⚠️ 配套约定：**引用块不再展平进 `MessageDTO.text`** —— 否则消费方会把同一段引文
  显示两遍（引用条 + 正文里的 `[引用] …`）。这是 0.5.0 唯一的行为性变更，只影响
  **带引用的用户消息**（这些消息在 0.4.0 及以前本来就只能由桌面发出）。
- `host.session.message.delete`（`DeleteMessageParams`）：删除单条消息**及其之后的全部消息**
  （截断，与桌面右键菜单同一条路径）。不可逆，必须 `confirm: true`；
  电脑端还会拦两种情况：会话正在回复时拒（`E_BUSY`）、目标是 `role:'tool'` 的消息时拒
  （`E_BAD_REQUEST`）。结果不在应答里回传，而是推 `host.event.session.messages.reset`，
  客户端重拉窗口（与压缩同一条一致性策略 —— 不发明增量协议）。
- `MESSAGE_QUOTE_CAPABILITY`（`'message.quote'`）与 `MESSAGE_DELETE_CAPABILITY`（`'message.delete'`）：
  两个能力名。前者是**功能标记**（只决定界面给不给入口：旧电脑端不认 `quotes` 参数，
  RPC 会成功而引文被静默丢掉）；后者是**权限**（删消息是破坏性操作，电脑端必须独立 `assert`）。

### Notes

- **向后兼容**：`SendParams.quotes` / `MessageDTO.quotes` 均为可选字段，旧消费方忽略即可。
  但**旧电脑端会丢弃 `quotes` 参数**（普通字段，不报错）—— 所以手机端的「引用」入口
  **必须**由 `MESSAGE_QUOTE_CAPABILITY` 挡住，否则用户会以为引用了而 AI 当没看见。
- `host.session.message.delete` 是**新方法**：旧电脑端没有它，手机端据 `MESSAGE_DELETE_CAPABILITY`
  不显示入口（未声明 = `E_DENIED`，与既有 ACL 默认拒绝一致）。
- 0.4.0 的导出面保持不变。

## [0.4.0] - 2026-10-02

### Added

- **传输档位**（`TransferTier` / `transferTierOf` / `MESSAGE_DETAIL_CAPABILITY`）：把
  「直连 / 中继」的判定再映射一层成**可执行的传输档位** —— `direct` → `full`（完整），
  `relay` → `lean`（精简），**`unknown` → `lean`**（拍板：开局那一屏消息窗口才是全量最大的一笔，
  宁可把「其实是直连」的链路先按精简发）。这是两端共用的唯一一份口径：电脑端据此裁剪下行正文，
  手机端据此解释「工具输出为什么是空的」并显示当前档位。
- `MessageDTO.detail`（可选）：正文完整性标记。当前只有 `'omitted'` = 正文被档位有意省略
  （**不是**「这次调用没有输出」）。消费方判「有没有这个字段」，不要穷举取值。
- `MESSAGE_DETAIL_CAPABILITY`（`'message.detail'`）：裁剪的**能力闸门**名。手机端声明它 = 能渲染
  省略标记；电脑端列出它 = 会按档位裁剪并打标记。两边缺一就继续全量发送。

### Notes

- **向后兼容**：`MessageDTO.detail` 为可选字段，旧消费方忽略它即可；但对**旧手机端**而言，
  被省略的正文会被显示成「这次调用没有输出」—— 故裁剪**必须**由上面的能力名挡住，
  旧手机端（未声明该能力）继续收全量，不会出现这句假话。
- 本轮**只加口径，不加行为**：协议表、帧格式、方法表均无破坏性变更；0.3.0 的导出面保持不变。
- 已知代价（如实记录）：非 WebRTC 链路（同源 Broadcast / 测试注入）永远读不到候选对，
  于是永远落在 `lean`；真机上也存在「其实是直连但首个候选对未定形」的几秒。

## [0.3.0] - 2026-10-01

### Added

- **配对链接**（`buildPairingUrl` / `PAIRING_URL_BASE` / `PAIRING_URL_PARAM`）：二维码内容改为
  `https://virlen.cn/mobile?t=<配对数据>`。这样**系统相机 / 微信 / 任意浏览器**扫码就能直接打开
  手机端并自动配对，无需先装 App 再扫码；App 内的扫码器则从 URL 里取回 `t`。
- `parsePairingPayload` **新增识 URL**：输入是 URL 时自动取 `?t=` 再解析。三种输入都吃：
  URL / `vrp1:` 混淆串 / 旧版明文 JSON。

### Notes

- 向后兼容：新版能解旧码与旧串；**旧版解不了新码**（消费方需同步升级）。
- `PAIRING_URL_BASE` 是部署地址，`buildPairingUrl` 的第二个参数 `base` 可覆盖（自建 / 换域名）。
- 无破坏性变更；0.2.0 的导出面保持不变。

## [0.2.0] - 2026-09-30

### Changed

- **配对串（二维码 / 手工输入的"配对码"）不再是明文 JSON**：`encodePairingPayload` 现在输出
  `vrp1:` + `Base64URL(UTF-8(JSON) ⊕ 固定盐)`。目的只是让二维码文字 / 界面上的排查文本
  **不是一眼可读**（此前是 `{"v":2,"host":"dk-…","ticket":"…"}` 原文），并避免在复制粘贴 / 日志里
  直接暴露 ticket、设备 key、信令基址。
- `parsePairingPayload` **兼容两种输入**：带 `vrp1:` 前缀走解码；否则按旧版明文 JSON 解析 ——
  已生成 / 已截图的旧二维码、以及旧版本手抄的配对串仍能识别，**升级不会让旧码失效**。

### Added

- `PAIRING_OBFUSCATION_PREFIX`（`'vrp1:'`）：混淆串前缀，供消费方识别 / 展示。

### Notes

- ⚠️ **这是混淆，不是加密**：本包发布到公开 npm，固定盐在源码里可见，拿到源码即可解；
  且它**挡不住有人对着屏幕拍照**（二维码本就是给人扫的，App 会解回来）。
  真正的安全边界仍是「一次性 ticket + 电脑端确认弹窗 + 授权凭证」。
- 向后兼容：新版能解旧码；**旧版解不了新码**（消费方需同步升级到本版或更高）。
- 零依赖：自带 Base64URL 实现，不依赖 `btoa` / `atob` / `Buffer`。

## [0.1.2] - 2026-09-28

### Changed

- `host.event.connection.changed` 的 `degraded` 字段改为**可选**，并在协议表中标注为「预留，当前不发送」：
  该字段此前是**必填却无任何定义 / 无任何消费方**的悬空字段，强类型 `emit` 会强迫未来多端的发送方
  编造一个值。当前实现只区分 `path`（直连 / 中继），没有独立可观测的「降级」判据，故转为可选，
  并在注释里明确：消费方**不得**用 `path === 'relay'` 反推它。

### Notes

- 兼容性：对**消费方**无破坏（可选字段可缺席）；对发送方为**放宽**（不再强制提供）。
- 无运行时行为变更。

## [0.1.1] - 2026-09-28

### Added

- **链路类型判定**（`classifyLinkKind` / `probeLinkKind` / `LinkKindWatcher` / `LINK_KIND_POLL_MS`）：
  从 `RTCPeerConnection.getStats()` 的**所选候选对**判定本次连接是 P2P 直连还是 TURN 中继
  （`host` / `srflx` / `prflx` → 直连；任一端 `relay` → 中继；拿不到结论 → `unknown`，**不猜**）。
  这是**两端共用的唯一一份口径**：此前电脑端（virlen-app）与手机端（virlen-mobile）各持一份副本，
  存在「手机说直连、电脑说中继」的漂移风险，本版收敛到本包。附带导出 `pickCandidatePair` /
  `findCandidate`，供消费方按**同一次挑选**提取其它 stats 字段（rtt / 协议等）。

### Notes

- 无破坏性变更；0.1.0 的导出面保持不变。
- 判定逻辑为**纯函数**（喂 `Record<string, unknown>[]` 即可），不依赖 DOM 类型。

## [0.1.0] - 2026-09-30

首次发布。内容为 Virlen「手机控制」M0–M6 期间沉淀的协议栈，两端（virlen-app / virlen-mobile）此前以源码方式共用，
本版起改为从 npm 安装。

### Added

- **协议层**：帧编解码 / 分片重组（`encodeFrames` / `Reassembler`）、RPC 端点（`Endpoint`：幂等、超时、重放）、
  错误码（`BridgeError` / `toBridgeError`）、能力协商（`negotiate` / `intersectCapabilities`）、
  方法表与 DTO（`createCaller` / `createSubscriber` / `registerHostHandlers`、`HostApi` / `MobileApi`）。
- **设备身份与授权凭证**：`newDeviceKey` / `roomFor` / `issueGrant` / `renewGrant` / `checkGrant` /
  `describeGrantRemaining`（30 天滑动续期 + 90 天硬上限）。
- **配对载荷**：`buildPairingPayload` / `encodePairingPayload` / `parsePairingPayload` / `roomOfPayload`
  （二维码内容，两端同一份；票据默认 5 分钟有效）。
- **传输层**：`Transport` 抽象；`RtcTransport`（WebRTC DataChannel，含被顶号 `E_REPLACED` 语义）、
  `MemoryTransport` / `createMemoryPair`（测试）、`BroadcastTransport`（同源跨 tab 联调）；
  `SseSignalingClient`（角色化加入、顶号通知、`requireHostOnline`）、
  `fetchRoomStatus` / `fetchHostOnlineMap`（批量在线查询，失败返回空而不抛错）。
- **流式下行**：`host.event.message.stream` 支持 `mode: 'full' | 'delta'` —— 客户端在 `hello` 里
  声明 `streamMode: 'delta'` 后只发新增后缀（带 `offset` 供重基准与缺口对齐）：
  一条 n 字回复的下行带宽从 O(n²) 降到 O(n)；未声明的客户端继续收整帧。
- **ICE 配置**：`resolveIceServers` / `fetchIceServers` / `sanitizeIceServers` / `parseIceText` /
  `readCustomIceText` / `writeCustomIceText` —— 客户端**不含任何 TURN 凭证**，
  默认值由服务端 `GET <信令基址>/ice` 下发，本地缓存 + 多级降级。
- **测试辅助**（子路径 `virlen-remote/testing`）：`createMockHostDataSource()`。

### Notes

- **ESM only**，零运行时依赖，Node ≥ 18。
- 构建产物会补全相对导入的 `.js` 后缀（运行时 ESM 加载器要求），见 `scripts/build.mjs`。
- 对外类型不用 DOM 类型做契约（ICE 条目为 `IceServerInit`），避免要求消费方开启 DOM lib。
- 若消费方 tsconfig 关闭了 `strictNullChecks`，判别字段请用 `x.ok === false` 显式比较：
  真值判断不收敛联合类型。

[0.1.0]: https://github.com/WeiChens/virlen-remote/releases/tag/v0.1.0
[0.1.1]: https://github.com/WeiChens/virlen-remote/releases/tag/v0.1.1
[0.1.2]: https://github.com/WeiChens/virlen-remote/releases/tag/v0.1.2
[0.2.0]: https://github.com/WeiChens/virlen-remote/releases/tag/v0.2.0
[0.3.0]: https://github.com/WeiChens/virlen-remote/releases/tag/v0.3.0
[0.4.0]: https://github.com/WeiChens/virlen-remote/releases/tag/v0.4.0
[0.5.0]: https://github.com/WeiChens/virlen-remote/releases/tag/v0.5.0
[0.6.0]: https://github.com/WeiChens/virlen-remote/releases/tag/v0.6.0
