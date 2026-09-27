import { describe, it, expect } from 'vitest'
import {
  BridgeError,
  FrameKind,
  HEADER_SIZE,
  PROTOCOL_VERSION,
  Reassembler,
  decodeHeader,
  encodeFrames,
} from '../src/index'

describe('帧编解码 / 分片 / 归组', () => {
  it('小载荷：单帧，头字段与往返一致', () => {
    const frames = encodeFrames(FrameKind.EVENT, 7, { a: 1 })
    expect(frames).toHaveLength(1)

    const header = decodeHeader(frames[0])
    expect(header).toMatchObject({
      version: PROTOCOL_VERSION,
      kind: FrameKind.EVENT,
      chunkIndex: 0,
      chunkCount: 1,
      msgId: 7,
    })
    expect(frames[0].length).toBeGreaterThanOrEqual(HEADER_SIZE)

    const r = new Reassembler()
    expect(r.accept(frames[0])?.payload).toEqual({ a: 1 })
    expect(r.pendingCount).toBe(0)
  })

  it('大载荷：自动分片（chunkCount>1），头里报出总数', () => {
    const payload = { text: 'a'.repeat(50 * 1024) }
    const frames = encodeFrames(FrameKind.CALL, 1, payload)
    expect(frames.length).toBeGreaterThan(1)
    expect(decodeHeader(frames[0]).chunkCount).toBe(frames.length)
    expect(decodeHeader(frames[0]).chunkIndex).toBe(0)
    expect(decodeHeader(frames[frames.length - 1]).chunkIndex).toBe(frames.length - 1)
  })

  it('分片乱序到达仍能还原', () => {
    const payload = { text: 'b'.repeat(40 * 1024) }
    const frames = encodeFrames(FrameKind.CALL, 2, payload)
    const shuffled = [...frames].reverse() // 完全逆序

    const r = new Reassembler()
    let out: ReturnType<Reassembler['accept']> = null
    for (const f of shuffled) {
      out = r.accept(f) ?? out
    }
    expect(out?.payload).toEqual(payload)
  })

  it('多条消息交错（不同 msgId）互不干扰', () => {
    const r = new Reassembler()
    const f1 = encodeFrames(FrameKind.CALL, 10, { text: 'c'.repeat(20 * 1024) })
    const f2 = encodeFrames(FrameKind.EVENT, 11, { text: 'd'.repeat(20 * 1024) })

    const results: Array<NonNullable<ReturnType<Reassembler['accept']>>> = []
    const max = Math.max(f1.length, f2.length)
    for (let i = 0; i < max; i++) {
      if (f1[i]) {
        const m = r.accept(f1[i])
        if (m) results.push(m)
      }
      if (f2[i]) {
        const m = r.accept(f2[i])
        if (m) results.push(m)
      }
    }

    expect(results).toHaveLength(2)
    expect(results.map((m) => m.header.msgId).sort((a, b) => a - b)).toEqual([10, 11])
  })

  it('分片不完整则整体丢弃（不做部分应用）', () => {
    const frames = encodeFrames(FrameKind.CALL, 3, { text: 'e'.repeat(30 * 1024) })
    const r = new Reassembler()

    let out: ReturnType<Reassembler['accept']> = null
    for (let i = 0; i < frames.length - 1; i++) {
      out = r.accept(frames[i]) ?? out
    }
    expect(out).toBeNull()
    expect(r.pendingCount).toBe(1) // 仍在等待最后一片
  })

  it('坏帧：长度不足时 decodeHeader 抛 E_BAD_REQUEST', () => {
    try {
      decodeHeader(new Uint8Array(4))
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('E_BAD_REQUEST')
    }
  })

  it('chunkIndex 越界 → 丢弃该组并抛错', () => {
    const bogus = encodeFrames(FrameKind.CALL, 5, { text: 'f'.repeat(20 * 1024) })
    // 手工构造一个 chunkIndex 越界的帧（复用头，改第 3、4 字节）
    const broken = new Uint8Array(bogus[0])
    new DataView(broken.buffer).setUint16(2, 9999, true)
    const r = new Reassembler()
    expect(() => r.accept(broken)).toThrow(BridgeError)
  })
})
