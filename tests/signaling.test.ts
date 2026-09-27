import { describe, expect, it } from 'vitest'
import { BridgeError, SseSignalingClient, fetchRoomStatus } from '../src/index'
import type { EventSourceLike } from '../src/index'

interface FetchCall {
  url: string
  init?: { method?: string; body?: string }
}

function makeFetch(joinResponse: Record<string, unknown> = defaultJoin) {
  const calls: FetchCall[] = []
  const fetchImpl = (async (url: string, init?: FetchCall['init']) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/join')) {
      return { ok: true, status: 200, json: async () => joinResponse }
    }
    if (String(url).includes('/signal')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const defaultJoin = { id: 'me', room: 'r', role: 'guest', ip: '1.2.3.4', peers: [] }

class FakeEventSource implements EventSourceLike {
  onopen: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  closed = false
  constructor(public readonly url: string) {}
  close(): void {
    this.closed = true
  }
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

describe('SseSignalingClient', () => {
  it('join：POST /join，返回 selfId 并打开事件流', async () => {
    const { fetchImpl, calls } = makeFetch()
    const es = new FakeEventSource('')
    let eventsUrl = ''
    const client = new SseSignalingClient({
      baseUrl: 'https://x/api/rtc', // 无末尾斜杠，验证规范化
      room: 'room-1',
      role: 'guest',
      fetchImpl,
      eventSourceFactory: (url) => {
        eventsUrl = url
        return es
      },
    })
    const selfId = await client.join()
    expect(selfId).toBe('me')
    expect(calls[0].url).toBe('https://x/api/rtc/join')
    expect(JSON.parse(calls[0].init!.body!)).toMatchObject({ room: 'room-1', role: 'guest' })
    expect(eventsUrl).toContain('https://x/api/rtc/events?room=room-1&id=me')
  })

  it('join 响应里已有对端 → 触发 onPeer', async () => {
    const { fetchImpl } = makeFetch({ ...defaultJoin, peers: [{ id: 'host-9', role: 'host' }] })
    const es = new FakeEventSource('')
    const client = new SseSignalingClient({ baseUrl: 'https://x/', room: 'r', role: 'guest', fetchImpl, eventSourceFactory: () => es })
    const peers: Array<string | null> = []
    client.onPeer = (p) => peers.push(p)
    await client.join()
    expect(peers).toEqual(['host-9'])
  })

  it('SSE 事件路由：peer-joined / signal / peer-left', async () => {
    const { fetchImpl } = makeFetch()
    const es = new FakeEventSource('')
    const client = new SseSignalingClient({ baseUrl: 'https://x/', room: 'r', role: 'guest', fetchImpl, eventSourceFactory: () => es })
    const peers: Array<string | null> = []
    const data: unknown[] = []
    client.onPeer = (p) => peers.push(p)
    client.onData = (d) => data.push(d)
    await client.join()

    es.emit({ type: 'peer-joined', peer: { id: 'p1', role: 'host' } })
    es.emit({ type: 'signal', from: 'p1', data: { kind: 'offer', sdp: { type: 'offer' } } })
    es.emit({ type: 'peer-left', id: 'p1' })

    expect(peers).toEqual(['p1', null])
    expect(data).toHaveLength(1)
  })

  it('send：POST /signal 且带 to=对端', async () => {
    const { fetchImpl, calls } = makeFetch()
    const es = new FakeEventSource('')
    const client = new SseSignalingClient({ baseUrl: 'https://x/', room: 'r', role: 'guest', fetchImpl, eventSourceFactory: () => es })
    await client.join()
    es.emit({ type: 'peer-joined', peer: { id: 'p1', role: 'host' } })

    await client.send({ kind: 'answer', sdp: { type: 'answer' } })
    const signalCall = calls.find((c) => c.url.endsWith('/signal'))!
    expect(JSON.parse(signalCall.init!.body!)).toMatchObject({ from: 'me', to: 'p1' })
  })

  it('无对端时 send 直接 no-op（不发请求）', async () => {
    const { fetchImpl, calls } = makeFetch()
    const es = new FakeEventSource('')
    const client = new SseSignalingClient({ baseUrl: 'https://x/', room: 'r', role: 'guest', fetchImpl, eventSourceFactory: () => es })
    await client.join()
    await client.send({ kind: 'candidate' })
    expect(calls.some((c) => c.url.endsWith('/signal'))).toBe(false)
  })

  it('join 失败（HTTP 非 2xx）→ BridgeError', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch
    const client = new SseSignalingClient({ baseUrl: 'https://x/', room: 'r', role: 'guest', fetchImpl, eventSourceFactory: () => new FakeEventSource('') })
    await expect(client.join()).rejects.toBeInstanceOf(BridgeError)
  })

  it('close → 关闭事件流', async () => {
    const { fetchImpl } = makeFetch()
    const es = new FakeEventSource('')
    const client = new SseSignalingClient({ baseUrl: 'https://x/', room: 'r', role: 'guest', fetchImpl, eventSourceFactory: () => es })
    await client.join()
    client.close()
    expect(es.closed).toBe(true)
  })

  // ─────────────── M6：设备身份 / 单手机顶号 / 在线查询 ───────────────

  it('join 带上设备 key 与显示名（服务器据此标识身份）', async () => {
    const { fetchImpl, calls } = makeFetch()
    const client = new SseSignalingClient({
      baseUrl: 'https://x/',
      room: 'virlen:dk-01',
      role: 'host',
      deviceKey: 'dk-01',
      clientName: '我的电脑',
      fetchImpl,
      eventSourceFactory: () => new FakeEventSource(''),
    })
    await client.join()
    expect(JSON.parse(calls[0].init!.body!)).toMatchObject({
      room: 'virlen:dk-01',
      role: 'host',
      deviceKey: 'dk-01',
      clientName: '我的电脑',
    })
  })

  it('requireHostOnline：电脑不在线 → join 直接失败（不占 guest 位）', async () => {
    const { fetchImpl } = makeFetch({ ...defaultJoin, hostOnline: false })
    const client = new SseSignalingClient({
      baseUrl: 'https://x/',
      room: 'r',
      role: 'guest',
      requireHostOnline: true,
      fetchImpl,
      eventSourceFactory: () => new FakeEventSource(''),
    })
    await expect(client.join()).rejects.toMatchObject({ code: 'E_TRANSPORT' })
  })

  it('requireHostOnline：电脑在线则正常加入', async () => {
    const { fetchImpl } = makeFetch({ ...defaultJoin, hostOnline: true })
    const client = new SseSignalingClient({
      baseUrl: 'https://x/',
      room: 'r',
      role: 'guest',
      requireHostOnline: true,
      fetchImpl,
      eventSourceFactory: () => new FakeEventSource(''),
    })
    await expect(client.join()).resolves.toBe('me')
  })

  it('kicked 事件：通知上层 + 关流 + 此后不再发信令', async () => {
    const { fetchImpl, calls } = makeFetch()
    const es = new FakeEventSource('')
    const client = new SseSignalingClient({ baseUrl: 'https://x/', room: 'r', role: 'guest', fetchImpl, eventSourceFactory: () => es })
    const kicked: string[] = []
    client.onKicked = (info) => kicked.push(info.reason)
    await client.join()
    es.emit({ type: 'peer-joined', peer: { id: 'p1', role: 'host' } })

    es.emit({ type: 'kicked', reason: 'replaced' })
    expect(kicked).toEqual(['replaced'])
    expect(es.closed).toBe(true)
    expect(client.peerId).toBe(null)

    // 被顶号后再发 ICE/SDP 都是无意义的（房间已把我们移除）
    const before = calls.length
    await client.send({ kind: 'candidate' })
    expect(calls.length).toBe(before)
  })

  it('kicked 重复到达只通知一次（容忍重发）', async () => {
    const { fetchImpl } = makeFetch()
    const es = new FakeEventSource('')
    const client = new SseSignalingClient({ baseUrl: 'https://x/', room: 'r', role: 'guest', fetchImpl, eventSourceFactory: () => es })
    let count = 0
    client.onKicked = () => {
      count += 1
    }
    await client.join()
    es.emit({ type: 'kicked' })
    es.emit({ type: 'kicked' })
    expect(count).toBe(1)
  })
})

describe('fetchRoomStatus', () => {
  it('批量查询：POST /status，room 逐一映射', async () => {
    const calls: FetchCall[] = []
    const fetchImpl = (async (url: string, init?: FetchCall['init']) => {
      calls.push({ url: String(url), init })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rooms: [
            { room: 'virlen:dk-a', hostOnline: true, guestOnline: false, hostSince: 1 },
            { room: 'virlen:dk-b', hostOnline: false, guestOnline: false },
          ],
        }),
      }
    }) as unknown as typeof fetch

    const list = await fetchRoomStatus({ baseUrl: 'https://x/api/rtc', rooms: ['virlen:dk-a', 'virlen:dk-b'], fetchImpl })
    expect(calls[0].url).toBe('https://x/api/rtc/status')
    expect(JSON.parse(calls[0].init!.body!)).toEqual({ rooms: ['virlen:dk-a', 'virlen:dk-b'] })
    expect(list.map((s) => s.hostOnline)).toEqual([true, false])
  })

  it('服务不可用 / 老版本无此接口 → 返回空数组而不抛错（列表退化为「未知」）', async () => {
    const failing = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(fetchRoomStatus({ baseUrl: 'https://x/', rooms: ['r'], fetchImpl: failing })).resolves.toEqual([])

    const notFound = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch
    await expect(fetchRoomStatus({ baseUrl: 'https://x/', rooms: ['r'], fetchImpl: notFound })).resolves.toEqual([])
  })

  it('空列表不发请求', async () => {
    let called = 0
    const fetchImpl = (async () => {
      called += 1
      return { ok: true, status: 200, json: async () => ({ rooms: [] }) }
    }) as unknown as typeof fetch
    await expect(fetchRoomStatus({ baseUrl: 'https://x/', rooms: [], fetchImpl })).resolves.toEqual([])
    expect(called).toBe(0)
  })
})
