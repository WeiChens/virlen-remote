import { describe, it, expect } from 'vitest'
import { BridgeError, intersectCapabilities, negotiate } from '../src/index'

describe('版本与能力协商', () => {
  it('取交集：保持 local 顺序并去重', () => {
    expect(intersectCapabilities(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c'])
    expect(intersectCapabilities(['a', 'a', 'b'], ['a', 'b'])).toEqual(['a', 'b'])
    expect(intersectCapabilities(['a'], ['b'])).toEqual([])
  })

  it('主版本一致 → 返回交集', () => {
    const n = negotiate(
      { protocolVersion: 1, capabilities: ['session.list', 'session.send'] },
      { protocolVersion: 1, capabilities: ['session.send', 'stream.delta'] },
    )
    expect(n.protocolVersion).toBe(1)
    expect(n.capabilities).toEqual(['session.send'])
  })

  it('主版本不一致 → E_UNSUPPORTED（不试图兼容）', () => {
    try {
      negotiate({ protocolVersion: 1, capabilities: [] }, { protocolVersion: 2, capabilities: [] })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).code).toBe('E_UNSUPPORTED')
      expect((err as BridgeError).retryable).toBe(false)
    }
  })
})
