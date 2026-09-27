import { describe, it, expect } from 'vitest'
import { createBroadcastPair } from '../src/index'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 等到条件成立或超时。
 *
 * ⚠️ 不能只用一次 `setTimeout(0)`：`BroadcastChannel` 的跨上下文投递是异步的，
 * 在多个测试文件并行时（事件循环被占满）单次 tick 不保证送达 —— 表现为 `[] !== [[1,2,3]]`
 * 这种「本地永远绿、CI 偶发红」的抖动。而发版前的 `prepublishOnly` 会跑本用例，
 * 抖动就等于发不出去。
 */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) return
    await delay(5)
  }
}

const uniqueName = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2)}`

describe('BroadcastTransport（同源跨上下文）', () => {
  it('对连：双向投递，且不回给自己', async () => {
    const [a, b] = createBroadcastPair(uniqueName('vt'))
    const gotA: number[][] = []
    const gotB: number[][] = []
    a.onMessage((x) => gotA.push([...x]))
    b.onMessage((x) => gotB.push([...x]))

    a.send(new Uint8Array([1, 2, 3]))
    b.send(new Uint8Array([4, 5]))
    await waitFor(() => gotA.length > 0 && gotB.length > 0)

    expect(gotB).toEqual([[1, 2, 3]])
    expect(gotA).toEqual([[4, 5]])

    a.close()
    b.close()
  })

  it('close 后不再发送/接收', async () => {
    const [a, b] = createBroadcastPair(uniqueName('vt'))
    const got: number[][] = []
    b.onMessage((x) => got.push([...x]))

    a.close()
    expect(a.state).toBe('closed')
    a.send(new Uint8Array([9]))
    // 「什么都没有」只能靠等一段时间来验证（抛出去的帧有足够时间到达）
    await delay(50)
    expect(got).toHaveLength(0)

    b.close()
  })
})
