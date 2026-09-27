# 变更记录

本文件记录对外可见的变更（协议 / 导出面 / 行为）。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
