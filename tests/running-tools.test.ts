/**
 * 演示宿主的「执行中的工具」联调口（`RuntimeDTO.runningTools`）—— 手机端这一帧的唯一来源
 * （手机端 UI 联调 / 单测没有引擎，只能手推）。
 *
 * 为什么值得一组用例：`setRunningTools` 是**手工推的**，而消费方（手机端）看到的是
 * `runtime.changed` 的报文形状 —— 三条纪律一旦漂移，表现是「手机上少一行 / 多一行僵尸行」，
 * 不会报错：
 * 1. 传数组 → 帧里带 `runningTools`（数组条数即「几个工具在跑」）；
 * 2. 传空数组 → 帧里**不带**该字段（都跑完了），但 `working` 仍为 `true`（本轮没结束）；
 * 3. 传 `null` → 帧里**不带**该字段，并且 `working: false`（收工）；
 * 4. 与其它会话维度事件同一条**订阅门**：未订阅的会话一个字节都不推。
 */
import { describe, expect, it } from 'vitest'
import {
  Endpoint,
  createBroadcastPair,
  createCaller,
  registerHostHandlers,
  type HostApi,
  type HostEvents,
} from '../src/index'
import { createMockHostDataSource } from '../src/testing/index'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

function setup() {
  const [a, b] = createBroadcastPair(`running-tools-${Math.random().toString(36).slice(2)}`)
  const hostEp = new Endpoint({ transport: a })
  const clientEp = new Endpoint({ transport: b })
  const source = createMockHostDataSource()
  const reg = registerHostHandlers(hostEp, source)
  source.bind(reg.emit)
  return { caller: createCaller<HostApi>(clientEp), clientEp, source }
}

async function helloAndSubscribe(caller: ReturnType<typeof createCaller<HostApi>>): Promise<void> {
  await caller.call('host.hello', {
    protocolVersion: 1,
    client: { platform: 'test', appVersion: '0' },
    capabilities: ['session.list'],
    token: 'demo-token',
  })
  await caller.call('host.session.subscribe', { sessionId: 'demo-1' })
}

describe('mock 宿主 setRunningTools —— 「执行中的工具」这一帧', () => {
  it('推数组 → 带 runningTools；空数组 → 不带字段但仍 working；null → 不带字段且收工', async () => {
    const { caller, clientEp, source } = setup()
    const frames: HostEvents['host.event.session.runtime.changed']['runtime'][] = []
    clientEp.subscribe('host.event.session.runtime.changed', (p) => {
      frames.push((p as HostEvents['host.event.session.runtime.changed']).runtime)
    })
    await helloAndSubscribe(caller)

    source.setRunningTools('demo-1', [
      { toolCallId: 'tc-1', name: 'read_file', args: 'src/store/chat.ts' },
      { toolCallId: 'tc-2', name: 'execute_command' },
    ])
    await waitFor(() => frames.some((f) => f.runningTools != null))
    expect(frames.find((f) => f.runningTools != null)!.runningTools).toEqual([
      { toolCallId: 'tc-1', name: 'read_file', args: 'src/store/chat.ts' },
      { toolCallId: 'tc-2', name: 'execute_command' },
    ])

    source.setRunningTools('demo-1', [])
    await waitFor(() => frames.length >= 2)
    const cleared = frames[frames.length - 1]
    // 都跑完了：字段缺席（手机端据此收掉那几行），但本轮还在跑
    expect('runningTools' in cleared).toBe(false)
    expect(cleared.working).toBe(true)

    source.setRunningTools('demo-1', null)
    await waitFor(() => frames.length >= 3)
    const done = frames[frames.length - 1]
    expect('runningTools' in done).toBe(false)
    expect(done.working).toBe(false)
  })

  it('未订阅的会话不推（与消息 / 流式同一条订阅门）', async () => {
    const { caller, clientEp, source } = setup()
    const frames: HostEvents['host.event.session.runtime.changed'][] = []
    clientEp.subscribe('host.event.session.runtime.changed', (p) => {
      frames.push(p as HostEvents['host.event.session.runtime.changed'])
    })
    await helloAndSubscribe(caller)

    source.setRunningTools('demo-2', [{ toolCallId: 'tc-x', name: 'read_file' }])
    await flush(30)
    expect(frames.filter((f) => f.sessionId === 'demo-2')).toHaveLength(0)
  })
})
