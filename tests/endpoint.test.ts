import { describe, it, expect, vi } from 'vitest'
import {
  BridgeError,
  Endpoint,
  FrameKind,
  createMemoryPair,
  encodeFrames,
  type EndpointOptions,
} from '../src/index'

/** 冲刷微任务队列（memory transport 用 queueMicrotask 投递）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function setup(options?: Partial<EndpointOptions>) {
  const [a, b] = createMemoryPair()
  const epA = new Endpoint({ transport: a, ...options })
  const epB = new Endpoint({ transport: b, ...options })
  return { a, b, epA, epB }
}

describe('Endpoint — RPC / 事件', () => {
  it('call → handle：有来有回', async () => {
    const { epA, epB } = setup()
    epB.handle('add', (params) => {
      const { a, b } = params as { a: number; b: number }
      return { sum: a + b }
    })

    await expect(epA.call('add', { a: 1, b: 2 })).resolves.toEqual({ sum: 3 })
  })

  it('emit → subscribe：只接收', async () => {
    const { epA, epB } = setup()
    const seen: unknown[] = []
    epB.subscribe('evt', (payload) => seen.push(payload))

    expect(epA.emit('evt', { x: 1 })).toBe(true)
    await flush()
    expect(seen).toEqual([{ x: 1 }])
  })

  it('调用未注册的方法 → E_UNSUPPORTED', async () => {
    const { epA } = setup()
    await expect(epA.call('nope', {})).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
  })

  it('handler 抛 BridgeError → 原样透传 code', async () => {
    const { epA, epB } = setup()
    epB.handle('busy', () => {
      throw new BridgeError('E_BUSY', 'session is working')
    })

    await expect(epA.call('busy', {})).rejects.toMatchObject({ code: 'E_BUSY', retryable: true })
  })

  it('handler 抛普通错误 → 归一为 E_INTERNAL', async () => {
    const { epA, epB } = setup()
    epB.handle('boom', () => {
      throw new Error('kaboom')
    })

    await expect(epA.call('boom', {})).rejects.toMatchObject({ code: 'E_INTERNAL' })
  })

  it('超时：对端不响应 → E_TIMEOUT', async () => {
    const { epA, epB } = setup()
    epB.handle('slow', () => new Promise(() => {})) // 永不 resolve

    await expect(epA.call('slow', {}, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'E_TIMEOUT' })
    expect(epA.pendingCount).toBe(0) // 超时后清出 pending
  })

  it('链路未开放 → 立即 E_TRANSPORT（不发、不等待）', async () => {
    const { a, epA } = setup()
    a.disconnect()
    expect(epA.transportState).toBe('closed')
    await expect(epA.call('x', {})).rejects.toMatchObject({ code: 'E_TRANSPORT' })
    expect(epA.emit('x', {})).toBe(false)
  })

  it('大载荷经分片端到端往返', async () => {
    const { a, epA, epB } = setup()
    epB.handle('echo', (params) => params)

    const big = 'x'.repeat(50 * 1024)
    const res = (await epA.call('echo', { text: big })) as { text: string }
    expect(res.text).toBe(big)
    expect(a.stats.sent).toBeGreaterThan(1) // 确实分了片
  })
})

describe('Endpoint — 幂等（重复 CALL 去重）', () => {
  it('同一 requestId 的 CALL 到达两次：handler 只执行一次', async () => {
    const { a, epB } = setup()
    const handler = vi.fn(() => ({ ok: true }))
    epB.handle('op', handler)

    // 手工构造一条固定 requestId 的 CALL，直接喂给 epB（a.send → 投递到 b）
    const frames = encodeFrames(FrameKind.CALL, 999, { requestId: 'fixed-1', method: 'op', params: {} })
    for (const f of frames) a.send(f)
    await flush()
    for (const f of frames) a.send(f)
    await flush()

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('去重表超出容量时淘汰最旧（仍不重放最近的）', async () => {
    const { a, epB } = setup({ dedupeSize: 2 })
    const handler = vi.fn((params: unknown) => ({ got: (params as { n: number }).n }))
    epB.handle('op', handler)

    const send = (requestId: string, n: number) => {
      for (const f of encodeFrames(FrameKind.CALL, 1, { requestId, method: 'op', params: { n } })) a.send(f)
    }

    send('r1', 1)
    send('r2', 2)
    send('r3', 3)
    await flush()
    expect(handler).toHaveBeenCalledTimes(3)

    // r1 已被淘汰 → 重发会再次执行
    send('r1', 1)
    await flush()
    expect(handler).toHaveBeenCalledTimes(4)
  })
})

describe('Endpoint — 重连重放', () => {
  it('断线期间丢响应 → 恢复时用同一 requestId 重放，对端去重不重复执行', async () => {
    const { a, epA, epB } = setup()
    const handler = vi.fn(() => 'result-1')
    epB.handle('op', handler)

    // 客户端丢弃第一条到达的 RESULT → 调用保持 pending
    a.dropIncoming(1)

    const p = epA.call('op', {})
    await flush()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(epA.pendingCount).toBe(1)

    // 断线 → 恢复：epA 重放未决的 CALL
    a.disconnect()
    a.reconnect()
    await flush()

    await expect(p).resolves.toBe('result-1')
    expect(handler).toHaveBeenCalledTimes(1) // 去重生效，未重复执行
    expect(epA.pendingCount).toBe(0)
  })

  it('dispose 后未决调用以 E_TRANSPORT 拒绝', async () => {
    const { epA, epB } = setup()
    epB.handle('slow', () => new Promise(() => {}))

    const p = epA.call('slow', {}, { timeoutMs: 10_000 })
    await flush()
    epA.dispose()

    await expect(p).rejects.toMatchObject({ code: 'E_TRANSPORT' })
  })
})
