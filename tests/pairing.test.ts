/**
 * 配对载荷（二维码内容）—— 两端同一份契约的解析用例。
 *
 * 重点覆盖**兼容**：旧二维码（v1，`host` 是旧 hostId、带 `room`）必须照样能解析，
 * 否则线上已存在的码会在手机端升级后突然「无法识别」。
 */
import { describe, expect, it } from 'vitest'
import {
  PAIRING_PAYLOAD_VERSION,
  buildPairingPayload,
  encodePairingPayload,
  parsePairingPayload,
  roomOfPayload,
} from '../src/index'

describe('parsePairingPayload', () => {
  it('新码（v2）：字段齐全', () => {
    const text = JSON.stringify({
      v: 2,
      host: 'dk-0123456789abcdef',
      name: '我的电脑',
      ticket: 'pr-abc',
      signal: 'https://virlen.cn/api/rtc/',
    })
    const p = parsePairingPayload(text)!
    expect(p.v).toBe(2)
    expect(p.host).toBe('dk-0123456789abcdef')
    expect(p.name).toBe('我的电脑')
    expect(p.ticket).toBe('pr-abc')
    expect(p.signal).toBe('https://virlen.cn/api/rtc/')
    expect(roomOfPayload(p)).toBe('virlen:dk-0123456789abcdef')
  })

  it('旧码（无 v、带 room）：照样解析，并优先用码里的房间号', () => {
    const p = parsePairingPayload(
      JSON.stringify({ host: 'host-ab12cd34', name: 'Virlen 电脑', ticket: 'tk-x', room: 'virlen:host-ab12cd34' }),
    )!
    expect(p.v).toBe(1)
    expect(p.name).toBe('Virlen 电脑')
    expect(roomOfPayload(p)).toBe('virlen:host-ab12cd34')
  })

  it('缺字段：缺 host / 缺 ticket 一律 null；name 缺省回退 host', () => {
    expect(parsePairingPayload('{}')).toBe(null)
    expect(parsePairingPayload(JSON.stringify({ host: 'a' }))).toBe(null)
    expect(parsePairingPayload(JSON.stringify({ host: 'dk-01', ticket: 't' }))!.name).toBe('dk-01')
  })

  it('非 JSON / 空串：null（调用方给「不是 Virlen 配对码」）', () => {
    expect(parsePairingPayload('随便一段文字')).toBe(null)
    expect(parsePairingPayload('')).toBe(null)
    expect(parsePairingPayload('null')).toBe(null)
    expect(parsePairingPayload('[1,2]')).toBe(null)
  })
})

describe('buildPairingPayload / encode', () => {
  it('构造后可直接编码、解析回等价对象（往返一致）', () => {
    const built = buildPairingPayload({
      host: 'dk-0123456789abcdef',
      name: '我的电脑',
      ticket: 'pr-abc',
      signal: 'https://virlen.cn/api/rtc/',
    })
    expect(built.v).toBe(PAIRING_PAYLOAD_VERSION)
    const parsed = parsePairingPayload(encodePairingPayload(built))!
    expect(parsed).toEqual(built)
  })

  it('无 signal 时不下发该字段（同源 Broadcast 联调）', () => {
    const built = buildPairingPayload({ host: 'dk-01', name: 'c', ticket: 'pr-1' })
    expect('signal' in built).toBe(false)
  })
})
