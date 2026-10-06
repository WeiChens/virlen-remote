import { describe, expect, it } from 'vitest'
import { RtcTransport } from '../src/index'
import { createLoopbackSignaling } from './support/fake-signaling'
import { FakeWebRTCNetwork } from './support/fake-webrtc'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

/** 轮询等待条件成立（避免依赖固定延时）。 */
async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond() && Date.now() < deadline) await flush(5)
}

interface Pair {
  host: RtcTransport
  guest: RtcTransport
  net: FakeWebRTCNetwork
}

/** 建立一对通过「环回信令 + 假 WebRTC」相连的 RtcTransport。 */
async function pair(): Promise<Pair> {
  const [hostSig, guestSig] = createLoopbackSignaling()
  const net = new FakeWebRTCNetwork()
  const host = new RtcTransport({
    role: 'host',
    signaling: hostSig,
    createPeerConnection: net.factory,
  })
  const guest = new RtcTransport({
    role: 'guest',
    signaling: guestSig,
    createPeerConnection: net.factory,
  })
  void host.start()
  void guest.start()
  await Promise.all([host.whenReady(), guest.whenReady()])
  return { host, guest, net }
}

describe('RtcTransport —— 协商与数据通道', () => {
  it('host 发起 offer / guest 应答 → 两端 open', async () => {
    const { host, guest } = await pair()
    expect(host.state).toBe('open')
    expect(guest.state).toBe('open')
  })

  it('双向字节传输（host→guest、guest→host）', async () => {
    const { host, guest } = await pair()
    const gotHost: string[] = []
    const gotGuest: string[] = []
    guest.onMessage((b) => gotHost.push(text(b)))
    host.onMessage((b) => gotGuest.push(text(b)))

    host.send(bytes('hello-guest'))
    guest.send(bytes('hello-host'))
    await flush()

    expect(gotHost).toEqual(['hello-guest'])
    expect(gotGuest).toEqual(['hello-host'])
  })

  it('仅 host 建 PC；guest 等 offer（网络里只有两个 PC）', async () => {
    const { net } = await pair()
    expect(net.pcs).toHaveLength(2)
    // offerer 建了 data channel，answerer 收到对端 channel
    expect(net.pcs.some((p) => p.createdChannels.length > 0)).toBe(true)
    expect(net.pcs.some((p) => p.deliveredChannels.length > 0)).toBe(true)
  })

  it('状态变化会通知订阅者', async () => {
    const [hostSig, guestSig] = createLoopbackSignaling()
    const net = new FakeWebRTCNetwork()
    const host = new RtcTransport({ role: 'host', signaling: hostSig, createPeerConnection: net.factory })
    const guest = new RtcTransport({ role: 'guest', signaling: guestSig, createPeerConnection: net.factory })
    const states: string[] = []
    host.onStateChange((s) => states.push(s))
    void host.start()
    void guest.start()
    await Promise.all([host.whenReady(), guest.whenReady()])
    expect(states).toContain('open')
  })

  it('close() → closed，且后续 send 被丢弃', async () => {
    const { host, guest } = await pair()
    const gotGuest: string[] = []
    guest.onMessage((b) => gotGuest.push(text(b)))
    host.close()
    expect(host.state).toBe('closed')
    host.send(bytes('after-close'))
    await flush()
    expect(gotGuest).toEqual([])
  })

  it('对端离开 → 回到 connecting（等待重连），且主动拆除的收尾事件不得把它记成 closed', async () => {
    const [hostSig, guestSig] = createLoopbackSignaling()
    const net = new FakeWebRTCNetwork()
    const host = new RtcTransport({ role: 'host', signaling: hostSig, createPeerConnection: net.factory })
    const guest = new RtcTransport({ role: 'guest', signaling: guestSig, createPeerConnection: net.factory })
    const states: string[] = []
    host.onStateChange((s) => states.push(s))
    void host.start()
    void guest.start()
    await Promise.all([host.whenReady(), guest.whenReady()])

    guestSig.close() // 手机离开
    await flush()
    await flush() // 把 dc/pc 的收尾事件（异步投递）也等完

    expect(host.state).toBe('connecting')
    /*
     * 拆除动作（`dc.close()` / `pc.close()`）在真实浏览器里会补两条收尾事件回来。
     * 让它们参与状态机的话，这里会多一个 `closed`：对端自己走开，却被电脑端
     * 记成「链路故障」，白闪一次「出错（链路已关闭）」并重建一条不必重建的链路。
     */
    // 只有两段：连上（open）→ 对端走了（connecting）。多出来的任何一条都是泄漏的收尾事件
    expect(states).toEqual(['open', 'connecting'])
  })

  it('收到新 offer（对端原地重开）→ 同步回到 `connecting`：旧通道拆了，授权随之作废', async () => {
    const [hostSig, guestSig] = createLoopbackSignaling()
    const net = new FakeWebRTCNetwork()
    const host = new RtcTransport({ role: 'host', signaling: hostSig, createPeerConnection: net.factory })
    const guest = new RtcTransport({ role: 'guest', signaling: guestSig, createPeerConnection: net.factory })
    void host.start()
    void guest.start()
    await Promise.all([host.whenReady(), guest.whenReady()])
    const states: string[] = []
    guest.onStateChange((s) => states.push(s))

    // 电脑端 `dropLink()` 之后重发的那条 offer（同一个房间、新的 PeerConnection）
    guestSig.onData?.({ kind: 'offer', sdp: { type: 'offer', sdp: 'offer-2' } })

    /*
     * 必须是**同步**的：这条 `connecting` 唯一的来源是 `handleRemote` 自己（旧通道拆掉时
     * 不再补事件了）。等着它从别处来，上层就会带着旧链路的授权假在线（授权是 per-link 的，
     * 电脑端每条链路都重开握手闸门）。
     */
    expect(guest.state).toBe('connecting')
    await flush()
    expect(states).toEqual(['connecting'])
  })

  it('（回归）connectionState 先于 dc.onopen 时不得提前 ready —— 否则帧被静默丢弃', async () => {
    // 真机踩到的竞态：guest 侧 `connectionState='connected'` 先触发，DataChannel 稍后才 open。
    // 旧实现此刻即置 open 并 resolve whenReady → 手机 `call('host.hello')` 被放行，帧却发不出去
    // → 4s 后握手超时（手机提示“连接超时”，电脑端日志 open → 4s → connecting）。
    const [hostSig, guestSig] = createLoopbackSignaling()
    const net = new FakeWebRTCNetwork({ connectOrder: 'connection-first', autoOpenChannels: false })
    const host = new RtcTransport({
      role: 'host',
      signaling: hostSig,
      createPeerConnection: net.factory,
    })
    const guest = new RtcTransport({
      role: 'guest',
      signaling: guestSig,
      createPeerConnection: net.factory,
    })
    void host.start()
    void guest.start()

    // 先坐实“确实到达了危险点”：协商完成（connectionState=connected）但通道尚未 open。
    // 没有这条断言，下面的用例会在“协商压根没起来”时假通过。
    await waitFor(() => net.pcs.some((p) => p.connectionState === 'connected'))
    expect(net.pcs.some((p) => p.connectionState === 'connected')).toBe(true)

    // ① 状态不得是 open —— 旧实现会在此处变成 'open'
    expect(host.state).toBe('connecting')
    expect(guest.state).toBe('connecting')

    // ② whenReady 不得 resolve（否则上层会立刻开闸发帧）
    let hostReady = false
    let guestReady = false
    void host.whenReady().then(() => {
      hostReady = true
    })
    void guest.whenReady().then(() => {
      guestReady = true
    })
    await flush(30)
    expect(hostReady).toBe(false)
    expect(guestReady).toBe(false)

    // ③ send 必须被丢弃：直接观测底层 `dc.send` 是否被调用（与 fake 自身的丢包语义无关，
    //    否则“transport 错误放行 + fake 静默丢弃”也会让断言成立，用例就失去区分度）
    const offererPc = net.pcs.find((p) => p.createdChannels.length > 0)
    const offererDc = offererPc!.createdChannels[0]
    let rawSendCalls = 0
    const originalSend = offererDc.send.bind(offererDc)
    offererDc.send = (data: unknown): void => {
      rawSendCalls += 1
      originalSend(data)
    }
    host.send(bytes('early-frame'))
    await flush()
    expect(rawSendCalls).toBe(0)

    // ④ 通道真正 open 后，一切恢复正常
    net.openChannels()
    await Promise.all([host.whenReady(), guest.whenReady()])
    expect(host.state).toBe('open')
    expect(guest.state).toBe('open')

    const got: string[] = []
    guest.onMessage((b) => got.push(text(b)))
    host.send(bytes('late-frame'))
    await flush()
    expect(got).toEqual(['late-frame'])
    expect(rawSendCalls).toBe(1)
  })
})

describe('RtcTransport —— 被顶号（M6）', () => {
  /** 建一对相连的 transport，并同时交出信令对象（要模拟服务端顶号）。 */
  async function pairWithSignaling() {
    const [hostSig, guestSig] = createLoopbackSignaling()
    const net = new FakeWebRTCNetwork()
    const host = new RtcTransport({ role: 'host', signaling: hostSig, createPeerConnection: net.factory })
    const guest = new RtcTransport({ role: 'guest', signaling: guestSig, createPeerConnection: net.factory })
    void host.start()
    void guest.start()
    await Promise.all([host.whenReady(), guest.whenReady()])
    return { host, guest, hostSig, guestSig, net }
  }

  it('guest 被顶号：先报 E_REPLACED 再置 closed（顺序是契约）', async () => {
    const { guest, guestSig } = await pairWithSignaling()

    // 观测「错误」与「状态变化」的先后：先错误后状态，上层才能在被叫去重连之前知道是顶号
    const order: string[] = []
    let code = ''
    guest.onError((err) => {
      order.push('error')
      code = (err as { code?: string }).code ?? ''
    })
    guest.onStateChange((s) => {
      if (s !== 'open') order.push(`state:${s}`)
    })

    guestSig.kickFromServer('replaced')
    await flush()

    expect(order[0]).toBe('error')
    expect(code).toBe('E_REPLACED')
    expect(order).toContain('state:closed')
    expect(guest.state).toBe('closed')
  })

  it('被顶号后终态是 `closed` —— 拆链时被关掉的通道不得再补一条 `connecting`', async () => {
    const { guest, guestSig } = await pairWithSignaling()

    /*
     * 真机现场（2026-10）：电脑端被服务端顶号（手机端的自动重连会带来「旧 id 已过期」→
     * `kicked`）→ 本端拆链 → 被关掉的 DataChannel 迟到一条 `onclose` → 终态 `closed`
     * 被顶回 `connecting` → 上层（`virlen-app` 的 `PhoneControlService`）以为「链路还能自己
     * 回来」，把已经排好的原地重开撤销 → **电脑端停在「等待手机连接…」，而信令房间早已没有它**，
     * 手机端于是显示「电脑不在线」，怎么连都连不回来。
     */
    const states: string[] = []
    guest.onStateChange((s) => states.push(s))

    guestSig.kickFromServer('replaced')
    await flush()
    await flush() // 拆除动作的收尾事件（异步投递）都在这一轮里到齐

    expect(guest.state).toBe('closed')
    expect(states).toEqual(['closed'])
  })

  it('被顶号后：信令已关闭，后续对端变化不再重建 PC（不会又去抢线）', async () => {
    const { guest, guestSig, net } = await pairWithSignaling()
    const pcsBefore = net.pcs.length

    guestSig.kickFromServer('replaced')
    await flush()
    // 模拟「另一台手机把本端顶掉后，host 仍在对端列表里报事件」
    guestSig.onPeer?.('host-1')
    await flush(20)

    expect(guest.state).toBe('closed')
    expect(net.pcs.length).toBe(pcsBefore)
  })
})
