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

  it('对端离开 → 回到 connecting（等待重连）', async () => {
    const [hostSig, guestSig] = createLoopbackSignaling()
    const net = new FakeWebRTCNetwork()
    const host = new RtcTransport({ role: 'host', signaling: hostSig, createPeerConnection: net.factory })
    const guest = new RtcTransport({ role: 'guest', signaling: guestSig, createPeerConnection: net.factory })
    void host.start()
    void guest.start()
    await Promise.all([host.whenReady(), guest.whenReady()])

    guestSig.close() // 手机离开
    await flush()
    expect(host.state).toBe('connecting')
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
