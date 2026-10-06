/**
 * 压缩方式（`CompressParams.mode`）—— **取值域 + 能力名 + 演示宿主的真实执行**。
 *
 * 为什么值得一组用例：这个参数的两种取值在真机上只有一个可观察差别（产物形态），
 * 而它最危险的失败形态恰恰**不报错**：
 *
 * 1. **旧电脑端静默忽略 `mode`**（字段是普通的，RPC 照常成功），然后按电脑侧设置压缩 ——
 *    用户侧表现是「我点了正文压缩，结果还是 AI 摘要，还花了钱」。所以能力名必须能被手机端看见
 *    （`hello.capabilities`）；
 * 2. **mock 两种方式给同一句话**：那手机端的两条支路在单测里就再也分不开了（对着假行为发绿灯）；
 * 3. **不认识的取值必须拒**（`E_BAD_REQUEST`），而不是落回缺省 —— 落回缺省等于把手机端的
 *    拼写错误变成一次**要花钱的**模型调用。
 */
import { describe, expect, it } from 'vitest'
import {
  COMPRESS_MODES,
  COMPRESS_MODE_CAPABILITY,
  DEFAULT_COMPRESS_MODE,
  Endpoint,
  compressModeOf,
  createBroadcastPair,
  createCaller,
  registerHostHandlers,
  type HostApi,
  type MessageDTO,
} from '../src/index'
import { createMockHostDataSource } from '../src/testing/index'

const uniqueName = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2)}`

function setup() {
  const [a, b] = createBroadcastPair(uniqueName('compress'))
  const hostEp = new Endpoint({ transport: a })
  const clientEp = new Endpoint({ transport: b })
  const source = createMockHostDataSource()
  const reg = registerHostHandlers(hostEp, source)
  source.bind(reg.emit)
  return { caller: createCaller<HostApi>(clientEp), clientEp, source }
}

async function hello(caller: ReturnType<typeof createCaller<HostApi>>) {
  return caller.call('host.hello', {
    protocolVersion: 1,
    client: { platform: 'test', appVersion: '0' },
    capabilities: ['session.compress'],
    token: 'demo-token',
  })
}

describe('压缩方式取值域（两端同一份）', () => {
  it('compressModeOf：只认 ai / raw，且容忍大小写与首尾空白（与 Rust parse 同宽容度）', () => {
    expect(COMPRESS_MODES).toEqual(['ai', 'raw'])
    expect(DEFAULT_COMPRESS_MODE).toBe('ai')
    expect(compressModeOf('ai')).toBe('ai')
    expect(compressModeOf('Raw')).toBe('raw')
    expect(compressModeOf('  AI ')).toBe('ai')
    // 「不认识的取值」与「没传」必须能区分开：前者是手机端拼错了，应当拒
    expect(compressModeOf('summary')).toBeNull()
    expect(compressModeOf('')).toBeNull()
    expect(compressModeOf(null)).toBeNull()
    expect(compressModeOf(undefined)).toBeNull()
    expect(compressModeOf(1)).toBeNull()
  })

  it('mock 宿主如实声明能力名（否则手机端只会显示一个按钮，选择器那条路测不到）', async () => {
    const { caller } = setup()
    const helloResult = await hello(caller)
    expect(helloResult.capabilities).toContain(COMPRESS_MODE_CAPABILITY)
    // 压缩本身是**权限**（破坏性），与方式这个功能标记各管一段
    expect(helloResult.capabilities).toContain('session.compress')
  })
})

describe('mock 宿主按 mode 真的走出不同的产物', () => {
  it('不传 mode → 缺省 ai（旧手机端的行为一字不变）', async () => {
    const { caller, source } = setup()
    await hello(caller)
    await caller.call('host.session.compress', { sessionId: 'demo-1', confirm: true })
    expect(source.lastCompress()).toEqual({ sessionId: 'demo-1', mode: 'ai' })

    const page = await caller.call('host.session.messages', { sessionId: 'demo-1' })
    expect(page.messages).toHaveLength(1)
    const summary = page.messages[0] as MessageDTO
    expect(summary.text).toContain('之前的内容已压缩为摘要')
  })

  it('传 raw → 真的走正文压缩，且产物与 ai 那句不同', async () => {
    const { caller, source } = setup()
    await hello(caller)
    await caller.call('host.session.compress', { sessionId: 'demo-1', confirm: true, mode: 'raw' })
    expect(source.lastCompress()).toEqual({ sessionId: 'demo-1', mode: 'raw' })

    const page = await caller.call('host.session.messages', { sessionId: 'demo-1' })
    expect(page.messages[0]!.text).toContain('正文压缩')
    expect(page.messages[0]!.text).not.toContain('之前的内容已压缩为摘要')
  })

  it('不认识的 mode → E_BAD_REQUEST，且一次压缩都没执行（不落回缺省替用户花钱）', async () => {
    const { caller, source } = setup()
    await hello(caller)
    await expect(
      caller.call('host.session.compress', {
        sessionId: 'demo-1',
        confirm: true,
        mode: 'summary' as never,
      }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    // 请求确实到了电脑侧（否则上面那条报错可能来自链路而不是校验）
    expect(source.calls).toContain('host.session.compress')
    expect(source.lastCompress()).toBeNull()
  })

  it('两道老闸不因新增参数而松动：缺 confirm → 拒；占用充裕 → 拒', async () => {
    const { caller, source } = setup()
    await hello(caller)
    await expect(
      caller.call('host.session.compress', { sessionId: 'demo-1', confirm: false as never, mode: 'raw' }),
    ).rejects.toMatchObject({ code: 'E_CONFIRM_REQUIRED' })
    // demo-2 占用 5%：充裕到不该压（与桌面 token 环同判据），方式选谁都没用
    await expect(
      caller.call('host.session.compress', { sessionId: 'demo-2', confirm: true, mode: 'raw' }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    expect(source.lastCompress()).toBeNull()
  })
})
