# virlen-remote

Virlen「手机控制电脑」功能的**协议栈共享包** —— 电脑端（virlen-app）与手机端（virlen-mobile）
共用同一份实现，避免两端各写一份契约然后慢慢漂移。

- **零运行时依赖**：WebRTC 用浏览器原生 `RTCPeerConnection`，信令用 `fetch` + `EventSource`，
  Node 侧只用内存传输做测试。
- **ESM only**（`"type": "module"`）：Node ≥ 18，或任意现代打包器（Vite / webpack / esbuild / Rollup）。
- 自带类型声明（`.d.ts` + `.d.ts.map`，随包附源码便于跳转）。
- **源码与产物里都没有任何 TURN 凭证** —— ICE 默认值由服务端下发，见下文。

## 安装

```bash
npm i virlen-remote
# 或 pnpm add virlen-remote / yarn add virlen-remote
```

```ts
import { Endpoint, RtcTransport } from 'virlen-remote'
import { createMockHostDataSource } from 'virlen-remote/testing'   // 仅测试/联调用
```

## 它包含什么

| 分层 | 内容 |
|---|---|
| `protocol/` | 帧编解码与分片重组、RPC（`Endpoint` / 幂等 / 超时 / 重放）、错误码、能力协商、方法表与 DTO、设备身份与授权凭证、配对载荷、流式下行（整帧 / 增量）、工作目录文件（分类 / 限额 / base64 / 路径工具） |
| `transport/` | `Transport` 抽象 + 三种实现（`RtcTransport` / `MemoryTransport` / `BroadcastTransport`）、`SseSignalingClient`（信令）、ICE 配置解析 |
| `testing/`（子路径） | `createMockHostDataSource()`：可直接挂到 `registerHostHandlers` 的 mock 宿主，供两端联调与单测使用 |

## 快速开始

### 电脑端（host，发起 offer）

```ts
import {
  Endpoint,
  RtcTransport,
  SseSignalingClient,
  registerHostHandlers,
  newDeviceKey,
  roomFor,
  resolveIceServers,
} from 'virlen-remote'

// 设备 key 首次生成后**必须持久化**：它既是「这台电脑是谁」，也是房间号的来源
const deviceKey = newDeviceKey('host')
const signalUrl = 'https://your-server/api/rtc/'
const room = roomFor(deviceKey)

// ICE 默认值从信令服务取（服务端配置；本机可自定义覆盖）
const ice = await resolveIceServers({ baseUrl: signalUrl, storage: localStorage })

const signaling = new SseSignalingClient({
  baseUrl: signalUrl,
  room,
  role: 'host',
  deviceKey,
  clientName: '我的电脑',
})
const transport = new RtcTransport({ role: 'host', signaling, iceServers: ice.servers })
const endpoint = new Endpoint({ transport })

registerHostHandlers(endpoint, myDataSource) // 实现 HostDataSource 端口即可
void transport.start()
```

### 手机端（guest，应答方）

```ts
import {
  Endpoint,
  RtcTransport,
  SseSignalingClient,
  createCaller,
  type HostApi,
} from 'virlen-remote'

const signaling = new SseSignalingClient({
  baseUrl: signalUrl,
  room,                       // 与电脑端同一个房间（由电脑 key 派生）
  role: 'guest',
  deviceKey: mobileKey,
  requireHostOnline: true,    // 房间里没有电脑时立刻失败，而不是空等超时
})
const transport = new RtcTransport({ role: 'guest', signaling, iceServers: ice.servers })
await transport.start()
await transport.whenReady()

const caller = createCaller<HostApi>(new Endpoint({ transport }))
const hello = await caller.call('host.hello', {
  protocolVersion: 1,
  client: { platform: 'ios-web', appVersion: '0.1.0' },
  capabilities: ['session.list', 'session.send'],
  token, // 首次配对是一次性票据；之后是上一轮拿到的授权凭证
  mobileKey,
  mobileName: 'iPhone · 3f9a',
})
// 首次配对就在这里拿到长期凭证：
// hello.grant → { token: 'gt-…', issuedAt, expiresAt }
```

### 配对（二维码 / 配对串）

```ts
import {
  buildPairingPayload,
  buildPairingUrl,
  parsePairingPayload,
  roomOfPayload,
} from 'virlen-remote'

const payload = buildPairingPayload({ host: deviceKey, name: '我的电脑', ticket, signal: signalUrl })
const qrText = buildPairingUrl(payload)          // 画进二维码：'https://virlen.cn/mobile?t=vrp1:xxxx'
const back = parsePairingPayload(qrText)         // 手机端解析（URL / 混淆串 / 旧明文 JSON 都吃；认不出返回 null）
if (back) await connect(roomOfPayload(back), back.host, back.ticket)
```

> **配对链接**：二维码内容 = `https://virlen.cn/mobile?t=<配对数据>`，于是**系统相机 / 微信 / 任意浏览器**
> 扫码就能直接打开手机端并自动配对。手机端从 `?t=` 取回数据后同样交给 `parsePairingPayload`。
> 地址常量见 `PAIRING_URL_BASE`（自建 / 换域名给 `buildPairingUrl` 传第二个参数覆盖）。
>
> **关于混淆**：配对数据是 `vrp1:` + `Base64URL(JSON ⊕ 固定盐)`，只是让二维码文字 /
> 界面上的排查文本**不是一眼可读**，**不是加密** —— 固定盐在源码里，拿到源码即可解；它也
> 挡不住有人对着屏幕拍照。真正的安全边界是「一次性 ticket + 电脑端确认弹窗 + 授权凭证」。
> `parsePairingPayload` **同时接受** URL、混淆串与旧版明文 JSON（向后兼容）。前缀常量见 `PAIRING_OBFUSCATION_PREFIX`。

## 上下文压缩方式（§22）

`host.session.compress` 支持**两种压缩方式**，由 `CompressParams.mode` 指定：

| `mode` | 做法 | 产物 |
|---|---|---|
| `'ai'`（缺省） | 一次非流式模型调用（走对话页的压缩提示词） | 模型写的摘要，最省 token，**慢且要花钱** |
| `'raw'` | 纯本地渲染，毫秒级、零消耗 | 整段历史重排成一段文本（用户 / 助手正文**一字不删**，只丢深度思考并省略超长工具参数与输出） |

```ts
import { COMPRESS_MODE_CAPABILITY, COMPRESS_MODES, DEFAULT_COMPRESS_MODE, compressModeOf } from 'virlen-remote'

// 手机端：先看电脑端认不认这个参数，再决定给不给选择器
const canPick = hello.capabilities.includes(COMPRESS_MODE_CAPABILITY)
await caller.call('host.session.compress', { sessionId, confirm: true, mode: canPick ? 'raw' : undefined })

// 电脑端：校验手机传来的取值（"没传"与"不认识"必须分开处理）
const mode = params.mode == null ? DEFAULT_COMPRESS_MODE : compressModeOf(params.mode)
if (!mode) throw new BridgeError('E_BAD_REQUEST', `未知的压缩方式: ${params.mode}`)
```

⚠️ **`mode` 只在电脑端声明 `COMPRESS_MODE_CAPABILITY`（`'session.compress.mode'`）时才能传**：
它是个普通字段，**旧电脑端会静默忽略它**，然后按电脑侧设置里的方式压缩 —— 用户侧的表现是
「我点了正文压缩，结果还是 AI 摘要（还花了钱）」，且没有任何报错可查。
能力名是**功能标记**而不是权限：压缩本身的授权仍是 `session.compress`（破坏性、需 `confirm: true`）。

⚠️ **`raw` 的产物比 `ai` 长得多**（正文一字不删，数万字符是常态）：消费方渲染摘要时不要假定
「摘要一定短」；产物形态与方式的对应关系还经 `ui_data.compressMode` 落库，供界面说明用。

## 工作目录文件（§37）

手机端能浏览 / 预览 / 下载 / **上传** / **编辑**电脑上**当前会话工作目录**里的文件。

| 方法 | 作用 |
|---|---|
| `host.file.list` | 列目录（非递归；只给名字 / 是否目录 / 大小 / 修改时刻） |
| `host.file.read` | 分块读（单次 ≤ `FILE_CHUNK_BYTES` = 256KB）；预览与下载走**同一条**路；应答带 `mtimeMs`（编辑保存的版本凭据） |
| `host.file.write.begin` | 开始上传 / **覆写**（校验大小 / 名字 / 目标目录；上传**在开始时就定名**） |
| `host.file.write.chunk` | 写一块（偏移必须等于已接收字节数 —— 乱序即拒） |
| `host.file.write.finish` | 收尾：临时文件 `rename` 落盘（上传 = 挑空位改名，覆写 = **替换**目标） |
| `host.file.write.abort` | 放弃（删临时文件；幂等，且**不过非中继门槛**） |

四个能力名（ACL 四档，可分别开关；默认全开）：`file.browse` / `file.download` / `file.upload` /
`file.edit`（最后一档只管「改写已有文件」，详见下面《编辑保存》）。

```ts
import {
  FILE_CHUNK_BYTES, FILE_UPLOAD_MAX_BYTES,
  bytesToBase64, base64ToBytes,
  previewKindOf, previewLimitOf, mimeTypeOf,
  fileTransferDeniedReason,
} from 'virlen-remote'

// 手机端：分块读（拼接与进度都在客户端）
let offset = 0
const parts: Uint8Array[] = []
for (;;) {
  const chunk = await caller.call('host.file.read', { sessionId, path: 'src/index.ts', offset })
  const bytes = base64ToBytes(chunk.data)   // 而不是把整个文件塞进一次 RPC
  parts.push(bytes)
  offset += bytes.length
  if (chunk.eof) break
}

// 电脑端：当前链路能不能传文件（**两端同一句话**）
const reason = fileTransferDeniedReason(linkKind) // 'relay' → 拒；'direct' / 'unknown' → null
```

要点：

- **非中继门槛**：只在**确认走了 TURN 中继**时拒（每个字节都要过服务器绕一圈，而文件动辄几 MB）；
  `direct` 与 `unknown` 都放行 —— `unknown` 是常态（同源 Broadcast 联调 / 非 WebRTC 链路），
  拿不准就禁用等于让功能在联调里根本进不来。这不采用 `TransferTier` 的「拿不准就少发」取向，
  因为那边的代价只是少一段正文，而这边是**功能直接消失**；
- **为何是 base64 分块**（而不是整文件 / 二进制帧）：帧层载荷是 UTF-8 JSON，且一条逻辑消息要
  攒齐全部分片才交付 —— 整文件塞一次会同时炸掉两端的组装缓冲；换二进制帧则要改帧格式与主版本。
  代价是 33% 的 base64 开销，换来进度可见、可取消、单请求内存上界固定；
- **落盘是原子的**：`begin` 之后字节只写临时文件（`.virlen-part`），`finish` 才 `rename` 到目标名
  —— 传输中断 / 用户取消不会在用户的项目里留下一个「打开是坏的」半截文件；
- **磁盘安全不在本包**：越权防线是消费方（电脑端）的 `resolveSafePath`（会话工作目录 + 黑白名单）。
  本包只负责把手机传来的相对路径规整成**可控形状**（`normalizeRelPath` 会把逃出工作目录的
  `..` 段就地吃掉）——规则写在这里是因为两端都要用同一份，而不是因为它是安全边界。

### 编辑保存（覆写已有文件）

手机端改一份文本 / 代码 / Markdown 源码时走**同一条分块通道**，但语义是覆写而不是新建：

```ts
import {
  bytesToBase64, base64ToBytes,
  decodeUtf8Strict, detectEolStyle, hasUtf8Bom, encodeEditedText,
} from 'virlen-remote'

// ① 打开：记下电脑侧给的版本凭据
const read = await caller.call('host.file.read', { sessionId, path: 'src/index.ts' })
const original = decodeUtf8Strict(base64ToBytes(read.data))!

// ② 保存：把编辑后的字节传上去，并声明「我打开时是哪一版」
const bytes = encodeEditedText(edited, {
  eol: detectEolStyle(original),
  bom: hasUtf8Bom(base64ToBytes(read.data)),
})
const begin = await caller.call('host.file.write.begin', {
  sessionId, dir: 'src', name: 'index.ts', size: bytes.length,
  overwrite: true,
  expectMtimeMs: read.mtimeMs!,   // **必须带**：不带就直接 E_BAD_REQUEST
  expectSize: read.size,
})
// …chunk 循环与上传完全一样…
const done = await caller.call('host.file.write.finish', { uploadId: begin.uploadId })
// 回执里的 mtimeMs 是**新的**版本凭据 —— 连改两次时第二次的校验得用它
```

要点（每一条都对应一次真机上会疼的失败）：

- **目标必须已存在，且不改名**：覆写是「原地改」而不是「另存为」，所以它与上传的
  「同名自动加 ` - 副本`」是两条路；路径写错时给 `E_NOT_FOUND`，**绝不新建**（手机端一个笔误
  不该在用户目录里凭空造出一个文件）；
- **必须带 `expectMtimeMs`**（不给就 `E_BAD_REQUEST`）：于是「盲写」这条路根本不存在 ——
  从手机上打开文件到按保存之间可能过了几分钟，期间 AI / 用户 / 编辑器都可能已经写过它，
  不校验版本就会把这些改动**静默吞掉**。版本不符回 `E_CONFLICT`，由界面让用户选
  「重新载入 / 强制覆盖」（强制覆盖 = **先取一次当前版本再写**，仍是带版本地写）；
- **换行与 BOM 的往返用共享包**（`detectEolStyle` / `applyEolStyle` / `hasUtf8Bom` /
  `encodeEditedText`）：手机上的 `<textarea>` 只有 LF（HTML 规范），而 Windows 上的源码大多是
  CRLF —— 照 LF 存回去等于在「只改了三个字符」的改动里混进一次**全文行尾改写**；
- **非 UTF-8 不给编**（`decodeUtf8Strict` 返回 `null`）：宽容解出来的乱码存回去就是毁文件
  （原本在电脑上还能正常看的文件，之后连电脑上也读不回来了）；
- **编辑上限 `FILE_EDIT_MAX_BYTES` = 256KB**（比预览的 1MB 严）：编辑要把全文塞进 `textarea`
  并整篇回传，超限只读（「请在电脑上改」）；
- **能力名 `file.edit`**（第四档，默认开、与 `file.upload` 分开）：上传最坏只是让项目里**多一个
  文件**，而覆写是**把已有文件的内容换掉**（那可能是源码）——「只让手机传照片、不让手机改代码」
  是一种应该被支持的授权。它同时是**功能标记**：旧电脑端会静默忽略 `overwrite`（一次覆盖保存
  退化成「另存为 - 副本」，用户以为改了、原文件其实没动），所以手机端只在电脑端声明它时才
  显示「编辑」入口。

### 消息里引用文件（`SendParams.files`）

手机端可以把**电脑上的文件**挂在要发的那条消息上 —— 与桌面输入框的「文件附件」同一条口径：
**只带路径，不搬运内容**，具体内容由 AI 用 `read_file` 按需读取。

```ts
import { MESSAGE_FILE_CAPABILITY, sanitizeFileRefs } from 'virlen-remote'

// 手机端：只在电脑端声明了这个能力位时才给「引用」入口（与 quotes 同一条教训）
if (capabilities.includes(MESSAGE_FILE_CAPABILITY)) {
  await caller.call('host.session.send', {
    sessionId, text: '帮我看看这个文件',
    files: [{ path: 'E:/proj/src/a.ts', name: 'a.ts', size: 1024 }],
  })
}

// 电脑侧：真实现与演示宿主都用这一份校验（两端唯一口径）
const checked = sanitizeFileRefs(params.files)
if (!checked.ok) throw new BridgeError('E_BAD_REQUEST', checked.reason)
```

要点：

- **不搬运内容**：与「上传文件」是两件不同的事 —— 上传是把字节搬到电脑侧，这里是告诉模型
  「用户附了这个文件」（电脑侧组装成 `{type:'file'}` 块，各 Provider 序列化成
  `[User attached file] <path>`）。引用的永远是**当前**内容，不会拿一份过期副本去回答；
- **路径是电脑上的绝对路径**（与 `SessionSummaryDTO.workspace` / `host.file.list` 的 `absPath`
  同一口径，手机上本来就看得见工作目录），手机上它只是一段可复制的文本；
- **形状非法 → 拒整条**（`E_BAD_REQUEST`），**不静默丢掉那一条**：§36 的教训是「假绿灯比报错
  难查得多」—— 丢一条时手机端 chip 还在、用户以为带上了，而 AI 从未看到。超上限
  （`MESSAGE_FILE_MAX` = 20）与路径过长（`MESSAGE_FILE_PATH_MAX`）同理；
- **`isDir` / `size` 只是展示元数据**（形状不对就丢字段）；目录也能被引用（模型用 `list_files`
  去看里面有什么）；
- **结构化下行**：`MessageDTO.files` 与 `quotes` 并列，文件引用**不进 `text`** —— 电脑侧投影正文时
  本就会把文件块展平成 `[文件] <名字>`（§7-⑦，与图片同一套降级规则），两条路同时走会显示两遍，
  而那个展平占位符**只有名字没有路径**（同一目录下两个 `index.ts` 长得一样）；
- **能力名 `message.file`**（**功能标记**，不是权限）：文件引用本身就是 `session.send` 的一个参数，
  越权防线仍是 `session.send`。写进能力表的用途是让手机端知道「本机电脑端认识 `files`」——
  旧电脑端会把未知字段**静默丢掉**。

### 联调（`virlen-remote/testing`）

```ts
import { createMockHostDataSource } from 'virlen-remote/testing'

// 自带一棵演示文件树：真 PNG（可预览）、未知类型的 build/app.bin（只能下载）、若干源码文件
const host = createMockHostDataSource({ fileLinkKind: 'relay' }) // 'relay' = 所有文件方法与真实电脑端一样拒
await host.listFiles({ sessionId: 'demo-1' })
host.readMockFile('demo-1', 'upload.bin')  // 上传是否真的落到那个路径与那些字节
// 演示文件树**每格有自己的 mtime**（写盘即换）：
host.writeMockFile('demo-1', 'README.md', '# AI 刚改的\n') // 模拟「电脑上有人改了它」→ 手机端保存拿到 E_CONFLICT
```

## ICE / TURN 配置

**本包与两个客户端里都没有任何 TURN 凭证。** 默认值由**服务端**提供：

```
GET <信令基址>/ice
→ { "v": 1,
    "iceServers": [ { "urls": "stun:turn.example.com:3478" },
                    { "urls": "turn:turn.example.com:3478", "username": "…", "credential": "…" } ],
    "mode": "static" | "rest" | "none",
    "ttlSec": 3600, "expiresAt": 1730000000000 }
```

客户端用 `resolveIceServers()` 解析，优先级与降级：

```
自定义（用户手填）
  > 服务端下发的本地缓存（默认 6 小时）
    > 服务端现取
      > 过期缓存（信令暂时不可达时，旧的也比没有强）
        > 空（仅本机候选；局域网可用，跨网多半不行）
```

```ts
import { resolveIceServers } from 'virlen-remote'

const ice = await resolveIceServers({
  baseUrl: signalUrl,
  customText: localStorage.getItem('virlen.rtc.ice'), // 用户自定义（空 = 用服务端默认）
  storage: localStorage,                              // 缓存位置
})
ice.servers   // → 交给 new RTCPeerConnection({ iceServers })
ice.source    // → 'custom' | 'remote' | 'cache' | 'stale-cache' | 'none'
ice.detail    // → 给用户看的中文说明（两端同一套口径）
ice.warning   // → 降级原因（如「信令服务暂不可达，先用上次缓存」）
```

要点：

- **永不抛错**：任何一步失败都降级到下一优先级，并把来源如实报给上层 ——
  「拿不到 TURN 配置」不该让用户连不上，只该让跨网连通率变差；
- 服务端可配**静态口令**，也可用 coturn `use-auth-secret` 下发**临时凭证**
  （HMAC-SHA1 现算，密钥永不下发；被抄走也只有一小时额度）；
- 凭证会随 `iceServers` 一起进内存，因此**不要**把它写进日志或埋点
  （本包提供 `iceCount` / `iceSource` 这类只记元数据的写法）。

## 约定与边界

- **不用 DOM 类型做对外契约**：例如 ICE 条目是结构等价的 `IceServerInit`
  而非 DOM 的 `RTCIceServer`，避免把「需要 DOM lib」扩散到所有消费方；
- `Transport.onError?()` 是**可选**方法：只有 `RtcTransport` 有致命错误通道（如被顶号 `E_REPLACED`）；
- **布尔判别字段请显式比较**（`x.ok === false` 而不是 `!x.ok`）：若消费方 tsconfig 关了
  `strictNullChecks`，真值判断不收敛联合类型；
- **被顶号不要自动重连**：信令服务是「后来者优先」，自动重连会让两台设备互相顶号；
- 房间号由电脑设备 key 派生（`roomFor`）：**知道 key 就能进房间**，授权关口是凭证校验。

## 维护者：构建与发布

```bash
pnpm install
pnpm typecheck && pnpm test    # 类型检查 + 用例
pnpm build                     # 产出 dist/（ESM + .d.ts）
npm publish                    # prepublishOnly 会自动跑上面三步
```

`pnpm build` 在 `tsc` 之后会把产物里的**相对导入补上 `.js` 后缀**：
源码里的免后缀写法对打包器友好，但**运行时 ESM 加载器不认**（`./protocol/frame` 会 404）。
本包是被 `import` 直接消费的，所以产物必须是合法 ESM。实现见 `scripts/build.mjs`
（零新增依赖，逐文件可 diff）。

## License

[MIT](./LICENSE)
