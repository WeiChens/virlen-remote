/**
 * Transport 抽象 —— 协议层与「字节通道实现」之间的唯一边界。
 *
 * 两条关键设计：
 * 1. **UI 永不直接碰这里**（docs/phone-control-bridge.md §1）：协议层只依赖本接口，
 *    将来把 RTC 整体挪到 Rust 时，**只换一个实现**，上面全部不动。
 * 2. **`bufferedAmount` 是必需的**：DataChannel 的 `send()` 不阻塞，
 *    接收慢时缓冲会静默堆积到爆内存 → 协议层据此做背压（§3.2）。
 */

export type TransportState = 'connecting' | 'open' | 'closed'

export interface Transport {
  readonly state: TransportState

  /** 未发送出去的字节数（DataChannel 的 `bufferedAmount`；内存实现恒为 0）。 */
  readonly bufferedAmount: number

  /** 发送一帧（可能被实现内部缓冲/异步投递）。链路非 open 时实现方负责丢弃。 */
  send(bytes: Uint8Array): void

  /** 关闭链路。 */
  close(): void

  /** 订阅「收到一帧」；返回取消订阅函数。 */
  onMessage(listener: (bytes: Uint8Array) => void): () => void

  /** 订阅「链路状态变化」；返回取消订阅函数。 */
  onStateChange(listener: (state: TransportState) => void): () => void

  /**
   * 可选：等待链路真正可用（RTC 需要先完成信令 + ICE 才 open）。
   * 内存 / Broadcast 实现创建即 open，可不实现此方法。
   */
  whenReady?(): Promise<void>

  /** 可选：启动链路（RTC 需要先加入信令房间并开始协商）。内存 / Broadcast 无需启动。 */
  start?(): void | Promise<void>

  /**
   * 可选：订阅「链路级错误」。
   *
   * 为什么必需（M6）：**被顶号**是一种错误而不是状态 —— 它对应的动作与「掉线（closed）」
   * 完全相反（掉线要自动重连，被顶号绝不能）。只有 `code === 'E_REPLACED'` 会被这样使用，
   * 见 `transport/rtc.ts` 与手机端 `store/connection.ts`。
   *
   * 内存 / Broadcast 实现没有致命错误，可不实现。
   */
  onError?(listener: (error: Error) => void): () => void
}
