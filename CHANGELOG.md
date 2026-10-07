# 变更记录

本文件记录对外可见的变更（协议 / 导出面 / 行为）。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.8.0] - 2026-10-07

### Added

- **窗口两阶段加载**：`MsgPageParams.detail?: 'full' | 'summary'` + `MessageDTO.deferred?: boolean`
  与新能力名 `MESSAGES_DETAIL_CAPABILITY`（`session.messages.detail`）。

  `detail:'summary'` 时电脑侧省掉两类**重字段**（工具执行输出 `text`、完整入参 `toolArgsFull`），
  只在受影响的条目上打 `deferred: true` —— 手机端据此**先渲染摘要**（用户立刻看到对话），
  随后后台再拉一次 `full` 按 id 补齐细节。解决「打开会话要等很久、白屏」的体验问题。

  ⚠️ **与 `detail:'omitted'` 语义不同**：那个是「按链路档位不下发」，这个是「马上会补发」。
  旧电脑端忽略 `detail` 即退化为一次拉全量（不会错，只是没省到），故手机端只在 `hello`
  应答里看到该能力名时才走两阶段。

- **演示宿主支持两阶段加载**：`createMockHostDataSource().getMessages` 现在按
  `detail:'summary'` 真的省字段并打 `deferred`，并在 hello 里声明 `session.messages.detail`
  —— 不声明 / 不实现的话，手机端的两阶段路径就永远测不到。

## [0.7.0] - 2026-10-07

### Added

- **工具调用成败标记**：`MessageDTO.isError?: boolean`（仅 `role:'tool'` 有意义）—— 工具执行
  结果的失败标记（与桌面工具卡片 `result.isError` 同一判据）。手机端据此在**单条工具卡**
  的头部显示 ✓/✗（**取代**原来的终端类别图标；工具组头不显示），**不再猜**（失败输出常常
  也是一段正常文本；成功输出里也可能出现形似错误的字样）。字段缺席 = 没有失败标记
  （成功 / 旧电脑端未下发），手机端一并按 ✓ 渲染。

  ⚠️ **不能靠正文反推**：`isError` 才是权威判据，手机端只认它。

- **消息里引用电脑上的文件（§37 的延伸）**：`SendParams.files?: MessageFileRef[]` 与
  `MessageDTO.files?: MessageFileRef[]` —— 手机端把文件面板里挑中的文件挂在要发的消息上，
  电脑端组装成 `{type:'file'}` 内容块（与桌面输入框的「文件附件」同一条口径：**只带路径，
  不搬运内容**，内容由 AI 用 `read_file` 按需读）。
  新能力名 `message.file`（**功能标记**，不是权限 —— 越权防线仍是 `session.send`）与新导出：
  `MessageFileRef` / `sanitizeFileRefs` / `MESSAGE_FILE_MAX`（20）/ `MESSAGE_FILE_PATH_MAX`（1024）/`FileRefSanitizeResult`。

  ⚠️ **校验口径只有一份**（`sanitizeFileRefs`，两端共用）：形状非法 / 超条数 / 路径过长 →
  **拒整条**（`E_BAD_REQUEST`），**不静默丢掉那一条** —— 丢一条时手机端 chip 还在、用户以为
  带上了，而 AI 从未看到（§36 引用那次踩过的坑）。`isDir` / `size` 只是展示元数据（形状不对
  就丢字段）；路径分隔符统一归一为 `/`；同一路径去重。

  ⚠️ **文件引用不进 `text`**（与 `quotes` 同一条纪律）：电脑侧投影正文时本就会把文件块展平成
  `[文件] <名字>`（§7-⑦，与图片同一套降级规则），两条路同时走会显示两遍，而那个展平占位符
  **只有名字没有路径**（同一目录下两个 `index.ts` 长得一样）。

- **演示宿主支持文件引用**：`createMockHostDataSource().send` 调同一份 `sanitizeFileRefs`
  （形状非法同样 `E_BAD_REQUEST`），并在 `MessageDTO.files` 上如实回带；hello 声明 `message.file`
  —— 否则手机端会隐藏入口，用例就永远测不到真实链路。

- **编辑保存 / 覆写已有文件（§37）**：`host.file.write.begin` 新增 `overwrite?: boolean` +
  `expectMtimeMs?` / `expectSize?`，`host.file.write.finish` 与 `host.file.read` 的应答各新增
  `mtimeMs?`（覆写后的新版本 / 打开时的版本凭据）。
  新能力名 `file.edit`（**权限 + 功能标记**，默认开，与 `file.upload` 分开：上传只让目录里多一个
  文件，覆写是把已有文件的内容换掉）与新导出：`FILE_EDIT_MAX_BYTES`（256KB）/ `EolStyle` /
  `isEditableKind` / `isEditableFileName` / `detectEolStyle` / `applyEolStyle` / `hasUtf8Bom` /
  `decodeUtf8Strict` / `encodeEditedText`。

  ⚠️ **覆写与上传是两条路**：目标必须**已存在**（不存在即 `E_NOT_FOUND`，不新建）、
  **不做同名改名**（不产生「 - 副本」）、**必须带打开时的版本**（不给即 `E_BAD_REQUEST` ——
  于是「盲写」这条路根本不存在），版本不符 → `E_CONFLICT`。旧电脑端会静默忽略 `overwrite`
  （一次覆盖保存会退化成「另存为 - 副本」，用户以为改了、原文件其实没动），故手机端只在
  `hello` 里看到 `file.edit` 时才给编辑入口。

- **演示宿主支持覆写**：`createMockHostDataSource()` 的文件树现在**每格带自己的 mtime**
  （写盘即换；否则冲突那条路径永远走不到），`beginFileWrite({ overwrite: true })` 会校验
  目标存在 / 可编辑扩展名 / 编辑上限 / `expectMtimeMs` / `expectSize`，`writeMockFile()` 可以
  模拟「电脑上有人改了它」。

- **上下文压缩方式（§22）**：`host.session.compress` 新增 `CompressParams.mode?: 'ai' | 'raw'` ——
  手机端可以选「AI 摘要」（一次模型调用，最省 token，但慢且要花钱）或「正文压缩」（纯本地渲染，
  毫秒级零消耗，用户 / 助手正文一字不删）。
  新能力名 `session.compress.mode`（**功能标记**，不是权限；压缩本身的授权仍是 `session.compress`）
  与新导出：`COMPRESS_MODES` / `DEFAULT_COMPRESS_MODE` / `COMPRESS_MODE_CAPABILITY` / `compressModeOf`
  与类型 `CompressMode`。

  ⚠️ **为何要能力名**：`mode` 是个普通字段，**旧电脑端会静默忽略**它而按电脑侧设置里的方式压缩
  —— 用户侧表现为「我点了正文压缩，结果还是 AI 摘要（还花了钱）」，没有任何报错可查。
  手机端因此只在电脑端声明该能力时才给选择器（否则只给一个按钮，走电脑侧设置）。
  不传 = 缺省 `ai`（与旧手机端行为一字不变）；**传了但不认识即 `E_BAD_REQUEST`** ——
  落回缺省等于把手机端的拼写错误变成一次要花钱的模型调用。

- **演示宿主按 `mode` 真的走出不同产物**：`createMockHostDataSource().compress` 现在校验 `mode`
  （未知取值 → `E_BAD_REQUEST`）并按它生成不同的摘要文案，另提供 `lastCompress()` 观察口
  （返回最后**真正执行**的那次 `{ sessionId, mode }`）—— 两种方式的差别在真机上就是产物形态，
  mock 若给同一句话，手机端的两条支路就再也分不开了。

- **工作目录文件（§37）**：手机端浏览 / 预览 / 下载 / 上传电脑上**会话工作目录**里的文件。
  六个新方法（电脑实现、手机调用）：
  - `host.file.list`（列目录，非递归，**只给**名字 / 是否目录 / 大小 / 修改时刻）；
  - `host.file.read`（分块读，单次最多 `FILE_CHUNK_BYTES` = 256KB）；
  - `host.file.write.begin` / `.chunk` / `.finish` / `.abort`（分块上传，**先写临时文件
    `.virlen-part`、`finish` 才改名**——中断不会在用户项目里留下半截文件）。

  三个新能力名（ACL 三档，默认全开）：`file.browse` / `file.download` / `file.upload`。
  新导出（两端同一份口径）：`previewKindOf` / `previewLimitOf` / `mimeTypeOf` / `bytesToBase64` /
  `base64ToBytes` / `formatFileSize` / `normalizeRelPath` / `joinRelPath` / `parentOfRelPath` /
  `baseNameOfPath` / `isSafeEntryName` / `duplicateNameCandidate` / `compareFileEntries` /
  `fileTransferDeniedReason` 与限额常量（`FILE_CHUNK_BYTES` / `FILE_UPLOAD_MAX_BYTES` =
  32MB / `FILE_TEXT_PREVIEW_MAX_BYTES` = 1MB / `FILE_IMAGE_PREVIEW_MAX_BYTES` = 8MB /
  `FILE_LIST_MAX_ENTRIES` / `FILE_NAME_MAX_LEN` / `UPLOAD_PART_SUFFIX`）。

  **非中继门槛**（用户 2026-10 拍板）：只在**确认走了 TURN 中继**（`relay`）时才拒，`direct` 与
  `unknown` 都放行——`unknown` 是常态（同源 Broadcast 联调 / 非 WebRTC 链路），把它判成禁用
  等于让功能在联调里根本进不来。口径收敛在 `fileTransferDeniedReason()`（两端同一句话）。

  ⚠️ **为何是 base64 分块而不是整文件**：帧层的载荷是 UTF-8 JSON 且要**攒齐全部分片**才交付，
  整文件塞一次会同时炸掉两端的组装缓冲（也不会改帧格式、不升主版本）。代价是 base64 的 33%
  开销；换来的是进度可见、随时可取消、单请求内存上界固定。

  磁盘安全**不在本包**：越权防线是消费方（电脑端）的 `resolveSafePath`（会话工作目录 + 黑白名单），
  本包只提供把手机传来的相对路径规整成可控形状的工具（`normalizeRelPath` 会把逃出工作目录的
  `..` 段就地吃掉）。

- **测试宿主新增演示文件树**（`virlen-remote/testing`）：`createMockHostDataSource()` 自带一棵
  真的演示文件树（含一张真 PNG 与一个未知类型的 `build/app.bin`），并提供
  `readMockFile` / `writeMockFile` / `listMockFiles` 三个观察口（上传是否真的落到对的路径与字节，
  只能从宿主侧看）。新增 `MockHostOptions.fileLinkKind: 'direct' | 'relay'` 用于模拟非中继门槛。

### Fixed

- **主动拆链不再补发事件（`RtcTransport::teardownPeer`）**：以前只是 `close()`，而浏览器里
  `dc.onclose` / `pc.onconnectionstatechange` 是**异步投递**的 —— 它们会在拆链方刚刚宣告的
  终态（`close()` / 被顶号都置 `closed`）**之后**再补一个 `connecting`。上游据此以为「链路还能
  自己回来」，把已经排好的原地重开撤销掉：电脑端停在「等待手机连接…」，而信令房间里早已没有它
  ——手机端因此显示「电脑不在线」且再也连不回来（2026-10 真机）。现在拆除前先摘监听器，
  「这条链路此刻是什么结论」一律由调用点显式 `setState` 说明。
  顺带修好同一个根的另一面：`pc.close()` 触发的 `connectionstatechange(closed)` 让上游把
  「手机主动走开」当成链路故障（每次对端离开都白进一次 `closed` 并重建一条链路）。
  同时**换对端（收到新 offer）时显式回到 `connecting`** —— 那条事件以前由被关掉的旧通道代劳，
  拆除静默之后必须自己说：新通道 `open` 之前链路不可用，且上层要重新握手（授权是 per-link 的）。
  回归：`tests/rtc-transport.test.ts`（假 WebRTC 的 `close()` 也改为异步投递，与浏览器一致）。
- **`fetchHostOnlineMap` 不再把「问不到」当成「不在线」**：旧实现是 `?? false` —— 一次查询失败
  （服务不可达 / 老服务没 `/status`）就让名单上**每一台**电脑都变成「电脑不在线」，而这与
  「服务端明确答了 `hostOnline: false`」是两件事。现在只写入**服务端明确答过**的房间，
  缺键即「未知」（消费方读到 `undefined` 自己渲染「状态未知」，与 `fetchRoomStatus`
  「失败返回空而不抛错」的本意一致）。

### Notes

- 两者都**不改导出面**（`fetchHostOnlineMap` 的返回类型仍是 `Map<string, boolean>`，只是可能缺键；
  `RtcTransport` 的公开方法集不变），对消费方无破坏性变更。

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
[0.6.1]: https://github.com/WeiChens/virlen-remote/releases/tag/v0.6.1
[0.7.0]: https://github.com/WeiChens/virlen-remote/releases/tag/v0.7.0
[0.8.0]: https://github.com/WeiChens/virlen-remote/releases/tag/v0.8.0
