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
| `protocol/` | 帧编解码与分片重组、RPC（`Endpoint` / 幂等 / 超时 / 重放）、错误码、能力协商、方法表与 DTO、设备身份与授权凭证、配对载荷、流式下行（整帧 / 增量） |
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
  encodePairingPayload,
  parsePairingPayload,
  roomOfPayload,
} from 'virlen-remote'

const payload = buildPairingPayload({ host: deviceKey, name: '我的电脑', ticket, signal: signalUrl })
const qrText = encodePairingPayload(payload)     // 画进二维码
const back = parsePairingPayload(qrText)         // 手机端解析（无法识别时返回 null）
if (back) await connect(roomOfPayload(back), back.host, back.ticket)
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
