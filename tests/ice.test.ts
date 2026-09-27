/**
 * ICE 取用策略用例（M7，§31）。
 *
 * 这里守的是一条**安全规则**与一条**可用性规则**：
 *   - 安全：客户端源码里不再有 TURN 凭证，默认值只能来自「自定义」或「服务端下发」；
 *   - 可用性：拿不到配置时**降级**而不是抛错（缓存 → 过期缓存 → 空），且如实报告来源。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ICE_CACHE_TTL_MS,
  ICE_CUSTOM_STORAGE_KEY,
  ICE_REMOTE_STORAGE_KEY,
  describeIceSource,
  fetchIceServers,
  formatIceServers,
  parseIceText,
  readCustomIceText,
  resolveIceServers,
  sanitizeIceServers,
  writeCustomIceText,
  type IceServerInit,
  type IceStoragePort,
} from '../src/transport/ice'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  const port: IceStoragePort & { raw: Map<string, string> } = {
    raw: map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v)
    },
  }
  return port
}

const TURN: IceServerInit = { urls: 'turn:example.com:3478', username: 'u', credential: 'p' }
const STUN: IceServerInit = { urls: ['stun:example.com:3478'] }

/** 造一个「服务端下发」的 fetch 替身。 */
function fetchIce(list: unknown, init: { ok?: boolean; onCall?: () => void } = {}) {
  return vi.fn(async (_url: string) => {
    init.onCall?.()
    return {
      ok: init.ok ?? true,
      json: async () => ({ v: 1, iceServers: list }),
    } as unknown as Response
  }) as unknown as typeof fetch
}

describe('sanitizeIceServers —— 筛坏条目，而不是让 RTCPeerConnection 抛错', () => {
  it('字符串 / 数组两种 urls 都接受（**保留书写形状**：数组不会被打平）', () => {
    expect(sanitizeIceServers([{ urls: 'stun:a:1' }, { urls: ['stun:b:1', 'turn:b:1'] }])).toEqual([
      { urls: 'stun:a:1' },
      { urls: ['stun:b:1', 'turn:b:1'] },
    ])
  })

  it('丢掉没有 urls 的条目，并过滤 urls 数组里的空串', () => {
    expect(sanitizeIceServers([null, 'x', {}, { urls: [] }, { urls: ['', '  '] }])).toEqual([])
    expect(sanitizeIceServers([{ urls: ['stun:a:1', '', '  '] }])).toEqual([{ urls: ['stun:a:1'] }])
  })

  it('保留 username / credential，非字符串的丢弃', () => {
    const turn: IceServerInit = { urls: 'turn:a:1', username: 'u', credential: 'p' }
    expect(sanitizeIceServers([{ urls: 'turn:a:1', username: 'u', credential: 'p' }])).toEqual([turn])
    expect(sanitizeIceServers([{ urls: 'turn:a:1', username: 1, credential: null }])).toEqual([
      { urls: 'turn:a:1' },
    ])
  })

  it('非数组输入 → 空列表', () => {
    expect(sanitizeIceServers(undefined)).toEqual([])
    expect(sanitizeIceServers({ urls: 'stun:a:1' })).toEqual([])
  })
})

describe('parseIceText —— 用户手填的 JSON 先校验再落盘', () => {
  it('空串 = 未填写（不是错误，表示「用服务端默认」）', () => {
    expect(parseIceText('   ')).toEqual({ ok: false, error: '未填写' })
  })

  it('不是 JSON / 不是数组 / 没有可用条目 → 各自的错误文案', () => {
    expect(parseIceText('nope')).toMatchObject({ ok: false })
    expect(parseIceText('{"urls":"stun:a:1"}')).toMatchObject({ ok: false, error: expect.stringContaining('数组') })
    expect(parseIceText('[{}]')).toMatchObject({ ok: false, error: expect.stringContaining('urls') })
  })

  it('合法输入 → 清洗后的列表', () => {
    const r = parseIceText(JSON.stringify([STUN, TURN, { urls: '' }]))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.servers).toEqual([STUN, TURN])
  })
})

describe('自定义配置的读写（设置页文本框）', () => {
  it('写入合法配置 → 规范化为格式化 JSON 落盘', () => {
    const storage = fakeStorage()
    expect(writeCustomIceText(storage, '[{"urls":"stun:a:1"}]')).toEqual({ ok: true })
    expect(storage.getItem(ICE_CUSTOM_STORAGE_KEY)).toBe(formatIceServers([{ urls: 'stun:a:1' }]))
  })

  it('写入非法配置 → 报错且**不覆盖**已有配置（错误在保存那一刻暴露）', () => {
    const storage = fakeStorage({ [ICE_CUSTOM_STORAGE_KEY]: formatIceServers([STUN]) })
    const r = writeCustomIceText(storage, '[{')
    expect(r.ok).toBe(false)
    expect(storage.getItem(ICE_CUSTOM_STORAGE_KEY)).toBe(formatIceServers([STUN]))
  })

  it('空文本 = 清除自定义（回到服务端默认）', () => {
    const storage = fakeStorage({ [ICE_CUSTOM_STORAGE_KEY]: formatIceServers([STUN]) })
    expect(writeCustomIceText(storage, '  ')).toEqual({ ok: true })
    expect(readCustomIceText(storage)).toBe('')
  })

  it('读取时坏数据按「没填」处理（不让用户看到一段乱码）', () => {
    expect(readCustomIceText(fakeStorage({ [ICE_CUSTOM_STORAGE_KEY]: '<<"bad' }))).toBe('')
    expect(readCustomIceText(undefined)).toBe('')
  })
})

describe('fetchIceServers —— 与信令服务同一域取默认值', () => {
  it('取到：读 { iceServers }，并清洗', async () => {
    const fetchImpl = fetchIce([TURN, { urls: '' }])
    expect(await fetchIceServers({ baseUrl: 'https://a/api/rtc/', fetchImpl })).toEqual([TURN])
  })

  it('基址末尾没有斜杠也能拼（与信令同一套 normalizeBase）', async () => {
    const fetchImpl = fetchIce([STUN])
    await fetchIceServers({ baseUrl: 'https://a/api/rtc', fetchImpl })
    expect((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]).toBe(
      'https://a/api/rtc/ice',
    )
  })

  it('宽容裸数组应答（老部署）', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => [STUN] })) as unknown as typeof fetch
    expect(await fetchIceServers({ baseUrl: 'https://a/', fetchImpl })).toEqual([STUN])
  })

  it('HTTP 非 2xx / 网络异常 / 非 JSON → null（「没问到」，与「服务端说没有」区分开）', async () => {
    const bad = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    expect(await fetchIceServers({ baseUrl: 'https://a/', fetchImpl: bad })).toBe(null)

    const boom = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    expect(await fetchIceServers({ baseUrl: 'https://a/', fetchImpl: boom })).toBe(null)

    const notJson = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error('not json')
      },
    })) as unknown as typeof fetch
    expect(await fetchIceServers({ baseUrl: 'https://a/', fetchImpl: notJson })).toBe(null)
  })

  it('超时会被打断（不能让「取默认值」把连接流程拖住）', async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ) as unknown as typeof fetch
    expect(await fetchIceServers({ baseUrl: 'https://a/', fetchImpl: hang, timeoutMs: 10 })).toBe(null)
  })
})

describe('resolveIceServers —— 优先级与降级', () => {
  it('自定义优先：填了就不去问服务端', async () => {
    const fetchImpl = fetchIce([TURN])
    const r = await resolveIceServers({
      baseUrl: 'https://a/api/rtc/',
      customText: JSON.stringify([STUN]),
      fetchImpl,
      storage: fakeStorage(),
    })
    expect(r.source).toBe('custom')
    expect(r.servers).toEqual([STUN])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('自定义写了但非法：降级到服务端默认，并带上 customError（UI 标红但不阻断连接）', async () => {
    const r = await resolveIceServers({
      baseUrl: 'https://a/api/rtc/',
      customText: '[{"urls":""}]',
      fetchImpl: fetchIce([TURN]),
      storage: fakeStorage(),
    })
    expect(r.source).toBe('remote')
    expect(r.servers).toEqual([TURN])
    expect(r.customError).toBeTruthy()
  })

  it('服务端下发 → 写缓存；TTL 内的下一次直接命中缓存（不再请求）', async () => {
    const storage = fakeStorage()
    const first = fetchIce([TURN])
    const now = 1_000_000
    const r1 = await resolveIceServers({ baseUrl: 'https://a/', fetchImpl: first, storage, now })
    expect(r1.source).toBe('remote')
    expect(storage.getItem(ICE_REMOTE_STORAGE_KEY)).toContain('turn:example.com:3478')

    const second = fetchIce([TURN])
    const r2 = await resolveIceServers({ baseUrl: 'https://a/', fetchImpl: second, storage, now: now + 1000 })
    expect(r2.source).toBe('cache')
    expect(r2.servers).toEqual([TURN])
    expect(second).not.toHaveBeenCalled()
  })

  it('缓存过期 → 重新取（TTL 之外）', async () => {
    const storage = fakeStorage()
    const now = 5_000_000
    await resolveIceServers({ baseUrl: 'https://a/', fetchImpl: fetchIce([TURN]), storage, now })
    const again = fetchIce([STUN])
    const r = await resolveIceServers({
      baseUrl: 'https://a/',
      fetchImpl: again,
      storage,
      now: now + ICE_CACHE_TTL_MS + 1,
    })
    expect(r.source).toBe('remote')
    expect(r.servers).toEqual([STUN])
    expect(again).toHaveBeenCalledTimes(1)
  })

  it('服务端明确回答「没配」（空数组）→ 空列表 + 提示，**不回退旧缓存**', async () => {
    const storage = fakeStorage()
    const now = 9_000_000
    await resolveIceServers({ baseUrl: 'https://a/', fetchImpl: fetchIce([TURN]), storage, now })
    const r = await resolveIceServers({
      baseUrl: 'https://a/',
      fetchImpl: fetchIce([]),
      storage,
      now: now + ICE_CACHE_TTL_MS + 1,
    })
    expect(r.source).toBe('none')
    expect(r.servers).toEqual([])
    expect(r.warning).toContain('未下发')
  })

  it('取不到（网络异常）但有旧缓存 → 用过期缓存并提示滞后', async () => {
    const storage = fakeStorage()
    const now = 3_000_000
    await resolveIceServers({ baseUrl: 'https://a/', fetchImpl: fetchIce([TURN]), storage, now })
    const boom = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const r = await resolveIceServers({
      baseUrl: 'https://a/',
      fetchImpl: boom,
      storage,
      now: now + ICE_CACHE_TTL_MS + 1,
    })
    expect(r.source).toBe('stale-cache')
    expect(r.servers).toEqual([TURN])
    expect(r.warning).toContain('上次缓存')
  })

  it('取不到又没缓存 → 空列表（仅本机候选），从不抛错', async () => {
    const boom = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const r = await resolveIceServers({ baseUrl: 'https://a/', fetchImpl: boom, storage: fakeStorage() })
    expect(r).toEqual({
      servers: [],
      source: 'none',
      detail: describeIceSource('none', 0),
      warning: '信令服务暂不可达',
    })
  })

  it('没有信令基址（同源 Broadcast 联调）→ 只用自定义/缓存', async () => {
    const r = await resolveIceServers({ storage: fakeStorage() })
    expect(r.source).toBe('none')
    expect(r.warning).toContain('未配置信令服务')
  })

  it('五项来源都有中文文案（两端共用，不能各说各话）', () => {
    expect(describeIceSource('custom', 2)).toBe('自定义 ICE（2 个服务器）')
    expect(describeIceSource('remote', 2)).toContain('服务端下发')
    expect(describeIceSource('cache', 2)).toContain('缓存')
    expect(describeIceSource('stale-cache', 2)).toContain('过期缓存')
    expect(describeIceSource('none', 0)).toContain('仅本机候选')
  })
})
