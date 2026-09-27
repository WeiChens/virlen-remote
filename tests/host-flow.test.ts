import { describe, it, expect } from 'vitest'
import {
  Endpoint,
  createBroadcastPair,
  createCaller,
  registerHostHandlers,
  type HostApi,
  type HostEvents,
  type InteractionDTO,
} from '../src/index'
import { createMockHostDataSource } from '../src/testing/index'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const uniqueName = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2)}`

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

describe('host 胶水 + mock 宿主（端到端，不依赖 WebRTC）', () => {
  it('列会话 → 看消息 → 发消息 → 收流式', async () => {
    const [a, b] = createBroadcastPair(uniqueName('flow'))
    const hostEp = new Endpoint({ transport: a })
    const clientEp = new Endpoint({ transport: b })
    const source = createMockHostDataSource({ streamSteps: 2, streamDelayMs: 2 })
    const reg = registerHostHandlers(hostEp, source)
    source.bind(reg.emit)

    const caller = createCaller<HostApi>(clientEp)

    const added: Array<{ sessionId: string; role: string }> = []
    const streams: Array<{ messageId: string; seq: number; final: boolean; mode: string }> = []
    const runtimes: Array<{ working: boolean }> = []
    clientEp.subscribe('host.event.message.added', (p) => {
      const e = p as HostEvents['host.event.message.added']
      added.push({ sessionId: e.sessionId, role: e.message.role })
    })
    clientEp.subscribe('host.event.message.stream', (p) => {
      const e = p as HostEvents['host.event.message.stream']
      streams.push({ messageId: e.messageId, seq: e.seq, final: e.final, mode: e.mode })
    })
    clientEp.subscribe('host.event.session.runtime.changed', (p) => {
      const e = p as HostEvents['host.event.session.runtime.changed']
      runtimes.push(e.runtime)
    })

    const hello = await caller.call('host.hello', {
      protocolVersion: 1,
      client: { platform: 'test', appVersion: '0' },
      capabilities: ['session.list', 'session.send'],
      token: 'demo-token',
    })
    expect(hello.deviceName).toBeTruthy()

    const { sessions } = await caller.call('host.session.list', {})
    expect(sessions.length).toBeGreaterThanOrEqual(2)

    // ⚠️ 先订阅：会话维度的事件（消息 / 流式 / 运行时）只推已订阅的会话（§24）
    await caller.call('host.session.subscribe', { sessionId: 'demo-1' })

    const page = await caller.call('host.session.messages', { sessionId: 'demo-1' })
    expect(page.messages.length).toBeGreaterThan(0)

    // 只回「投递确认」
    const { messageId } = await caller.call('host.session.send', { sessionId: 'demo-1', text: '你好' })
    expect(messageId).toBeTruthy()

    // 过程靠事件推
    await waitFor(() => added.some((m) => m.role === 'assistant'))
    expect(streams.some((s) => s.final)).toBe(true)
    // 未声明 `streamMode` → 一律整帧（旧客户端收到增量帧会把一帧当成全文）
    expect(streams.every((s) => s.mode === 'full')).toBe(true)
    expect(runtimes.some((r) => r.working === false)).toBe(true)

    reg.dispose()
    hostEp.dispose()
    clientEp.dispose()
    a.close()
    b.close()
  })

  /**
   * 订阅门（§24）：消息 / 流式 / 运行时 / 占用**只推已订阅的会话**，列表与交互事件恒推。
   *
   * 为何把 mock 也收紧到同一规则：它过去无条件推送，于是「客户端忘了 subscribe」这类缺陷
   * 在联调 / 单测里完全看不见 —— 真机上是「会话标题更新了，但消息永远是空的」。
   * 本用例同时断言门的**两侧**（未订阅不推 / 订阅后必推），避免把「推送坏了」误读成「门生效」。
   */
  it('订阅门：未订阅的会话不推消息 / 运行时；subscribe 之后才推', async () => {
    const [a, b] = createBroadcastPair(uniqueName('gate'))
    const hostEp = new Endpoint({ transport: a })
    const clientEp = new Endpoint({ transport: b })
    const source = createMockHostDataSource({ streamSteps: 1, streamDelayMs: 2 })
    const reg = registerHostHandlers(hostEp, source)
    source.bind(reg.emit)
    const caller = createCaller<HostApi>(clientEp)

    const added: Array<{ sessionId: string; id: string }> = []
    const runtimes: Array<{ sessionId: string; working: boolean }> = []
    clientEp.subscribe('host.event.message.added', (p) => {
      const e = p as HostEvents['host.event.message.added']
      added.push({ sessionId: e.sessionId, id: e.message.id })
    })
    clientEp.subscribe('host.event.session.runtime.changed', (p) => {
      const e = p as HostEvents['host.event.session.runtime.changed']
      runtimes.push({ sessionId: e.sessionId, working: e.runtime.working })
    })

    // demo-2 未订阅 → 消息与运行时都不该推过来（连流式也一样）
    await caller.call('host.session.send', { sessionId: 'demo-2', text: '未订阅' })
    await flush(40)
    expect(added).toHaveLength(0)
    expect(runtimes).toHaveLength(0)

    // 订阅后同一操作必须推得出来（否则用例会把「通道坏了」当成「门生效」）
    await caller.call('host.session.subscribe', { sessionId: 'demo-2' })
    await caller.call('host.session.send', { sessionId: 'demo-2', text: '已订阅' })
    await waitFor(() => added.some((m) => m.sessionId === 'demo-2') && runtimes.length > 0)

    // 未订阅会话的推送不得混进来
    expect(added.every((m) => m.sessionId === 'demo-2')).toBe(true)
    expect(runtimes.every((m) => m.sessionId === 'demo-2')).toBe(true)

    reg.dispose()
    hostEp.dispose()
    clientEp.dispose()
    a.close()
    b.close()
  })

  /**
   * §32：增量流式 —— 客户端在 `hello` 里声明 `streamMode:'delta'` 后，
   * 只发新增后缀（带 `offset`）。规则与真实电脑侧（`store-bridge` 的 `pushStream`）逐条对齐。
   *
   * 这里守的是一条恒等式：**增量帧拼起来必须等于收尾帧的正文**。
   * 它一旦不成立，真机上的表现就是「手机端正文缺字 / 错位」——比丢帧难查得多。
   */
  it('流式（§32）：声明 delta → 只收增量帧（offset 递增），拼起来等于定稿正文', async () => {
    const [a, b] = createBroadcastPair(uniqueName('delta'))
    const hostEp = new Endpoint({ transport: a })
    const clientEp = new Endpoint({ transport: b })
    const source = createMockHostDataSource({ streamSteps: 3, streamDelayMs: 2 })
    const reg = registerHostHandlers(hostEp, source)
    source.bind(reg.emit)
    const caller = createCaller<HostApi>(clientEp)

    const frames: Array<HostEvents['host.event.message.stream']> = []
    clientEp.subscribe('host.event.message.stream', (p) =>
      frames.push(p as HostEvents['host.event.message.stream']),
    )

    await caller.call('host.hello', {
      protocolVersion: 1,
      client: { platform: 'test', appVersion: '0' },
      capabilities: ['session.list', 'session.send'],
      token: 'demo-token',
      streamMode: 'delta',
    })
    await caller.call('host.session.subscribe', { sessionId: 'demo-1' })
    await caller.call('host.session.send', { sessionId: 'demo-1', text: '增量' })
    await waitFor(() => frames.some((f) => f.final))

    // 首帧整段（客户端没有任何基准）、中间全是增量、收尾帧整段
    expect(frames[0].mode).toBe('full')
    expect(frames[frames.length - 1].mode).toBe('full')
    const middles = frames.slice(1, -1)
    expect(middles.length).toBeGreaterThan(0)
    expect(middles.every((f) => f.mode === 'delta')).toBe(true)
    expect(middles.every((f) => f.offset != null)).toBe(true)

    // 按客户端的合并规则拼一遍（与 `virlen-mobile` 的 `applyStreamFrame` 同一套判定）
    let text = frames[0].text
    for (const f of middles) {
      expect(f.offset).toBe(text.length)
      text += f.text
    }
    expect(text).toBe(frames[frames.length - 1].text)

    reg.dispose()
    hostEp.dispose()
    clientEp.dispose()
    a.close()
    b.close()
  })

  it('令牌过期 → E_DENIED（登录页的「被拒绝」态）', async () => {    const [a, b] = createBroadcastPair(uniqueName('flow'))
    const hostEp = new Endpoint({ transport: a })
    const clientEp = new Endpoint({ transport: b })
    const source = createMockHostDataSource()
    const reg = registerHostHandlers(hostEp, source)
    source.bind(reg.emit)

    const caller = createCaller<HostApi>(clientEp)
    await expect(
      caller.call('host.hello', {
        protocolVersion: 1,
        client: { platform: 'test', appVersion: '0' },
        capabilities: [],
        token: 'expired',
      }),
    ).rejects.toMatchObject({ code: 'E_DENIED' })

    reg.dispose()
    hostEp.dispose()
    clientEp.dispose()
    a.close()
    b.close()
  })

  it('未知会话发消息 → E_NOT_FOUND 原样透传', async () => {
    const [a, b] = createBroadcastPair(uniqueName('flow'))
    const hostEp = new Endpoint({ transport: a })
    const clientEp = new Endpoint({ transport: b })
    const source = createMockHostDataSource()
    const reg = registerHostHandlers(hostEp, source)
    source.bind(reg.emit)

    const caller = createCaller<HostApi>(clientEp)
    await expect(caller.call('host.session.send', { sessionId: 'nope', text: 'x' })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })

    reg.dispose()
    hostEp.dispose()
    clientEp.dispose()
    a.close()
    b.close()
  })

  it('写操作：新建 / 重命名 / 置顶 / 删除（删除必须带 confirm，且由服务端独立校验）', async () => {
    const [a, b] = createBroadcastPair(uniqueName('flow'))
    const hostEp = new Endpoint({ transport: a })
    const clientEp = new Endpoint({ transport: b })
    const source = createMockHostDataSource()
    const reg = registerHostHandlers(hostEp, source)
    source.bind(reg.emit)

    const caller = createCaller<HostApi>(clientEp)
    const listChanges: number[] = []
    clientEp.subscribe('host.event.session.list.changed', (p) => {
      listChanges.push((p as HostEvents['host.event.session.list.changed']).sessions.length)
    })

    const { sessionId } = await caller.call('host.session.create', { title: '手机建的' })
    expect(sessionId).toBeTruthy()
    await caller.call('host.session.rename', { sessionId, title: '改名了' })
    await caller.call('host.session.pin', { sessionId, pinned: true })

    const after = await caller.call('host.session.list', {})
    expect(after.sessions.find((s) => s.id === sessionId)?.title).toBe('改名了')

    // ⚠️ 缺 confirm：绕开类型系统直接走线上路径，验证**服务端**确实拦（不靠手机 UI 自觉）
    await expect(
      clientEp.call('host.session.delete', { sessionId }),
    ).rejects.toMatchObject({ code: 'E_CONFIRM_REQUIRED' })
    expect((await caller.call('host.session.list', {})).sessions.some((s) => s.id === sessionId)).toBe(true)

    await caller.call('host.session.delete', { sessionId, confirm: true })
    expect((await caller.call('host.session.list', {})).sessions.some((s) => s.id === sessionId)).toBe(false)

    // 每次写操作都应触发列表推送（手机不靠本地乐观更新）
    await waitFor(() => listChanges.length >= 4)

    reg.dispose()
    hostEp.dispose()
    clientEp.dispose()
    a.close()
    b.close()
  })

  it('授权应答：低风险可批 / 高风险缺 confirmed 被拒且不消耗交互 / 重复应答 not-found', async () => {
    const [a, b] = createBroadcastPair(uniqueName('flow'))
    const hostEp = new Endpoint({ transport: a })
    const clientEp = new Endpoint({ transport: b })
    const source = createMockHostDataSource()
    const reg = registerHostHandlers(hostEp, source)
    source.bind(reg.emit)

    const caller = createCaller<HostApi>(clientEp)
    const requests: InteractionDTO[] = []
    const resolved: Array<{ id: string; by: string; outcome?: string }> = []
    clientEp.subscribe('host.event.interaction.requested', (p) => {
      requests.push((p as HostEvents['host.event.interaction.requested']).interaction)
    })
    clientEp.subscribe('host.event.interaction.resolved', (p) => {
      const e = p as HostEvents['host.event.interaction.resolved']
      resolved.push({ id: e.interactionId, by: e.by, outcome: e.outcome })
    })

    // 低风险：一次点击即放行
    const lowId = source.triggerInteraction({ tier: 'low', permName: 'terminal.normal.execute' })
    await waitFor(() => requests.length === 1)
    expect(requests[0].interactionId).toBe(lowId)
    expect(requests[0].tier).toBe('low')
    expect((await caller.call('host.interaction.answer', { interactionId: lowId, action: 'allow' })).accepted).toBe(true)
    await waitFor(() => resolved.length === 1)
    expect(resolved[0]).toMatchObject({ id: lowId, by: 'mobile', outcome: 'allow' })

    // 高风险：缺 confirmed → 拒，且交互仍挂起（可重新应答）
    const highId = source.triggerInteraction({
      tier: 'high',
      permName: 'terminal.dangerous.execute',
      sandboxBypass: true,
      risk: 'dangerous',
    })
    const rejected = await caller.call('host.interaction.answer', { interactionId: highId, action: 'allow' })
    expect(rejected).toMatchObject({ accepted: false, reason: 'confirm-required' })
    expect(source.pendingInteractions()).toContain(highId)

    expect(
      (await caller.call('host.interaction.answer', { interactionId: highId, action: 'allow', confirmed: true })).accepted,
    ).toBe(true)

    // 答完再答 / 未知 id → not-found（不是报错，UI 只需提示）
    expect(await caller.call('host.interaction.answer', { interactionId: highId, action: 'deny' })).toMatchObject({
      accepted: false,
      reason: 'not-found',
    })

    reg.dispose()
    hostEp.dispose()
    clientEp.dispose()
    a.close()
    b.close()
  })
})
