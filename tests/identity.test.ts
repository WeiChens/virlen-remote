/**
 * 设备身份与授权凭证（M6，§30）—— 纯函数层用例。
 *
 * 这里守的是**两端共用的判定口径**：有效性、滑动续期的硬上限、房间号派生。
 * 任何一条写错，都会变成「手机认为还有效、电脑认为已过期」这类只在真机出现的分叉。
 */
import { describe, expect, it } from 'vitest'
import {
  GRANT_MAX_LIFETIME_MS,
  GRANT_TTL_MS,
  checkGrant,
  describeGrantRemaining,
  hostKeyFromRoom,
  isDeviceKey,
  issueGrant,
  isGrantExpired,
  newDeviceKey,
  renewGrant,
  roomFor,
} from '../src/index'

const DAY = 24 * 60 * 60 * 1000

describe('设备 key', () => {
  it('生成：前缀正确、两次不同、长度稳定', () => {
    const a = newDeviceKey('host')
    const b = newDeviceKey('host')
    expect(a.startsWith('dk-')).toBe(true)
    expect(newDeviceKey('mobile').startsWith('mk-')).toBe(true)
    expect(a).not.toBe(b)
    expect(a.length).toBe(b.length)
  })

  it('校验：只认前缀 + 十六进制；跨类型不通过', () => {
    expect(isDeviceKey('dk-0123456789abcdef')).toBe(true)
    expect(isDeviceKey('dk-0123456789abcdef', 'host')).toBe(true)
    expect(isDeviceKey('dk-0123456789abcdef', 'mobile')).toBe(false)
    expect(isDeviceKey('mk-0123456789abcdef', 'mobile')).toBe(true)
    expect(isDeviceKey('dk-XXXXXXXX')).toBe(false)
    expect(isDeviceKey('host-ab12cd34')).toBe(false) // 旧 hostId 不是设备 key（但房间派生照样兼容）
    expect(isDeviceKey(undefined)).toBe(false)
  })
})

describe('房间号派生', () => {
  it('新 key 派生带前缀的房间名', () => {
    expect(roomFor('dk-0123456789abcdef')).toBe('virlen:dk-0123456789abcdef')
  })

  it('兼容 M3 旧 hostId：派生结果与旧实现逐字一致（旧二维码仍可用）', () => {
    expect(roomFor('host-ab12cd34')).toBe('virlen:host-ab12cd34')
  })

  it('反解：仅本前缀派生可解', () => {
    expect(hostKeyFromRoom('virlen:dk-01')).toBe('dk-01')
    expect(hostKeyFromRoom('other:dk-01')).toBe(null)
    expect(hostKeyFromRoom('virlen:')).toBe(null)
  })
})

describe('授权凭证', () => {
  it('签发：有效期 30 天、token 带 gt- 前缀', () => {
    const now = 1_700_000_000_000
    const g = issueGrant(now)
    expect(g.token.startsWith('gt-')).toBe(true)
    expect(g.issuedAt).toBe(now)
    expect(g.expiresAt).toBe(now + GRANT_TTL_MS)
    expect(checkGrant(g, now)).toBe(null)
  })

  it('过期判定：到期瞬间即失效（`>=` 而非 `>`）', () => {
    const now = 1_700_000_000_000
    const g = issueGrant(now)
    expect(isGrantExpired(g, g.expiresAt - 1)).toBe(false)
    expect(isGrantExpired(g, g.expiresAt)).toBe(true)
    expect(checkGrant(g, g.expiresAt)).toBe('expired')
  })

  it('滑动续期：每次连接推后 30 天', () => {
    const t0 = 1_700_000_000_000
    const g = issueGrant(t0)
    const r1 = renewGrant(g, t0 + 10 * DAY)
    expect(r1.expiresAt).toBe(t0 + 10 * DAY + GRANT_TTL_MS)
    expect(r1.token).toBe(g.token) // 续期不换串
    expect(r1.issuedAt).toBe(t0)
  })

  it('滑动续期有硬上限：不超过签发时刻 + 90 天（到顶后必须重新扫码）', () => {
    const t0 = 1_700_000_000_000
    const g = issueGrant(t0)
    // 80 天时续期：本来想推到 110 天，被 90 天硬上限截住
    const r = renewGrant(g, t0 + 80 * DAY)
    expect(r.expiresAt).toBe(t0 + GRANT_MAX_LIFETIME_MS)
    expect(r.expiresAt).toBe(t0 + 90 * DAY)
    // 到顶后即使用户天天上线，也不再续（到期日不变）
    const again = renewGrant(r, t0 + 95 * DAY)
    expect(again.expiresAt).toBe(t0 + GRANT_MAX_LIFETIME_MS)
    expect(checkGrant(again, t0 + 90 * DAY)).toBe('expired')
  })

  it('坏数据：缺 token / 全空一律 invalid', () => {
    expect(checkGrant(null)).toBe('invalid')
    expect(checkGrant(undefined)).toBe('invalid')
    expect(checkGrant({ token: '', issuedAt: 0, expiresAt: Date.now() + DAY })).toBe('invalid')
  })

  it('剩余期文案：天 / 小时 / 分钟三档（两端 UI 同一口径）', () => {
    const now = 1_700_000_000_000
    expect(describeGrantRemaining({ expiresAt: now + 5 * DAY }, now)).toBe('剩余 5 天')
    expect(describeGrantRemaining({ expiresAt: now + 3 * 60 * 60 * 1000 }, now)).toBe('剩余 3 小时')
    expect(describeGrantRemaining({ expiresAt: now + 5 * 60 * 1000 }, now)).toBe('剩余 5 分钟')
    expect(describeGrantRemaining({ expiresAt: now - 1 }, now)).toBe('已过期')
  })
})
