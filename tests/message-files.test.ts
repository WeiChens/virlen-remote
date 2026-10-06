/**
 * 消息里的**文件引用**（`SendParams.files` / `MessageDTO.files`）的共享契约用例。
 *
 * 这一组盯三件事：
 *
 * 1. **校验口径只有一份**（`sanitizeFileRefs`）：真电脑侧与演示宿主都调它，所以这里测到的
 *    就是真机上的行为。重点在「什么样的 `files` 会被拒」—— 假绿灯（静默丢掉一条引用）
 *    正是 §36 引用那次踩过的坑：手机端 chip 还在、AI 却没看见。
 * 2. **投影规则**：文件引用**不进 `text`**（与 `quotes` 同一条纪律），否则手机端会把
 *    「文件 chip + 正文里的 `[文件] …`」显示两遍。
 * 3. **能力位如实声明**：不声明的话手机端会隐藏「引用」入口，用例就永远测不到真实链路。
 */
import { describe, expect, it } from 'vitest'
import {
  MESSAGE_FILE_CAPABILITY,
  MESSAGE_FILE_MAX,
  MESSAGE_FILE_PATH_MAX,
  sanitizeFileRefs,
} from '../src/index'
import { createMockHostDataSource } from '../src/testing/index'

/* ───────────────────────── 校验与归一（两端同一份） ───────────────────────── */

describe('sanitizeFileRefs —— 缺省与形状', () => {
  it('缺省 / null / 空数组都是「没有文件引用」这条正常的路', () => {
    for (const input of [undefined, null, []]) {
      expect(sanitizeFileRefs(input)).toEqual({ ok: true, files: [], reason: '' })
    }
  })

  it('不是数组 / 条目不是对象 / 路径缺失或空 → 拒整条并给出原因（不静默丢掉那一条）', () => {
    for (const bad of ['a.ts', 42, {}, [null], [{}], [{ path: '' }], [{ path: '   ' }], [{ path: 1 }]]) {
      const result = sanitizeFileRefs(bad)
      expect(result.ok, JSON.stringify(bad)).toBe(false)
      // 被拒时 files 恒为空数组（不变式：没有「部分成功」这个态）
      expect(result.files).toEqual([])
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })

  it('路径分隔符统一成 `/`（两侧拼串才不会出现 `a\\/b`）', () => {
    const result = sanitizeFileRefs([{ path: 'E:\\proj\\src\\a.ts', name: 'a.ts' }])
    expect(result).toEqual({ ok: true, files: [{ path: 'E:/proj/src/a.ts', name: 'a.ts' }], reason: '' })
  })

  it('`name` 缺失或空 → 用路径末段兜底（电脑侧从内容块投影回来时也靠这条）', () => {
    const result = sanitizeFileRefs([{ path: 'E:/proj/src/a.ts' }, { path: 'E:/proj/b.ts', name: '  ' }])
    expect(result.files.map((f) => f.name)).toEqual(['a.ts', 'b.ts'])
  })

  it('`isDir` / `size` 形状不对就整个字段丢掉，但**路径非法必须拒**', () => {
    const result = sanitizeFileRefs([
      { path: 'E:/a', name: 'a', isDir: 'yes', size: -1 },
      { path: 'E:/b', name: 'b', size: Number.NaN },
    ])
    expect(result).toEqual({
      ok: true,
      files: [
        { path: 'E:/a', name: 'a' },
        { path: 'E:/b', name: 'b' },
      ],
      reason: '',
    })
  })

  it('同一路径只留第一次（手机端连点两下不该变成两条引用）', () => {
    const result = sanitizeFileRefs([{ path: 'E:/a.ts', name: 'a.ts' }, { path: 'E:\\a.ts', name: 'a.ts' }])
    expect(result.files.length).toBe(1)
  })

  it('目录引用带 isDir（模型用 list_files 去看里面有什么）', () => {
    const result = sanitizeFileRefs([{ path: 'E:/proj/src', name: 'src', isDir: true }])
    expect(result).toEqual({ ok: true, files: [{ path: 'E:/proj/src', name: 'src', isDir: true }], reason: '' })
  })

  it('超过条数上限 / 路径过长 → 拒整条并说明原因（截断是静默的，不能做）', () => {
    const tooMany = Array.from({ length: MESSAGE_FILE_MAX + 1 }, (_, i) => ({ path: `E:/f${i}`, name: `f${i}` }))
    const many = sanitizeFileRefs(tooMany)
    expect(many.ok).toBe(false)
    expect(many.reason).toContain(String(MESSAGE_FILE_MAX))
    // 刚好到上限仍然放行（边界是「最多 N 个」，不是「少于 N 个」）
    expect(sanitizeFileRefs(tooMany.slice(0, MESSAGE_FILE_MAX)).ok).toBe(true)

    const long = sanitizeFileRefs([{ path: `E:/${'x'.repeat(MESSAGE_FILE_PATH_MAX)}`, name: 'x' }])
    expect(long.ok).toBe(false)
    expect(long.reason).toContain('路径过长')
  })
})

/* ───────────────────────── 演示宿主上的整条链路 ───────────────────────── */

describe('演示宿主：带文件引用的发送', () => {
  it('hello 如实声明 message.file', async () => {
    const host = createMockHostDataSource()
    const hello = await host.hello!({
      protocolVersion: 1,
      client: { platform: 'test', appVersion: '0' },
      capabilities: [],
      token: 'demo-token',
    })
    expect(hello.capabilities).toContain(MESSAGE_FILE_CAPABILITY)
  })

  it('只带文件也能发：正文补兜底句、`files` 结构化下行、`text` 里**不含** `[文件]`', async () => {
    const host = createMockHostDataSource()
    const sent = await host.send({
      sessionId: 'demo-1',
      text: '',
      files: [{ path: 'E:/proj/README.md', name: 'README.md', size: 128 }],
    })

    const list = await host.getMessages({ sessionId: 'demo-1' })
    const message = list.messages.find((m) => m.id === sent.messageId)!
    expect(message.files).toEqual([{ path: 'E:/proj/README.md', name: 'README.md', size: 128 }])
    // 兜底句与电脑侧 `buildUserContent` 同义；展平占位符**不能**同时出现（否则显示两遍）
    expect(message.text).toBe('看看这些文件')
    expect(message.text).not.toContain('[文件]')
  })

  it('带正文时正文原样、`files` 与 `quotes` 可以同时带', async () => {
    const host = createMockHostDataSource()
    const sent = await host.send({
      sessionId: 'demo-1',
      text: '帮我看看这个',
      quotes: [{ messageId: 'm-1', role: 'assistant', text: '被引用的回答' }],
      files: [{ path: 'E:/proj/src/a.ts', name: 'a.ts' }],
    })
    const list = await host.getMessages({ sessionId: 'demo-1' })
    const message = list.messages.find((m) => m.id === sent.messageId)!
    expect(message.text).toBe('帮我看看这个')
    expect(message.quotes).toHaveLength(1)
    expect(message.files).toHaveLength(1)
  })

  it('路径被归一后落库（回读进来的是 `E:/proj/src/a.ts`，不是反斜杠那份）', async () => {
    const host = createMockHostDataSource()
    const sent = await host.send({
      sessionId: 'demo-1',
      text: 'x',
      files: [{ path: 'E:\\proj\\src\\a.ts', name: 'a.ts' }],
    })
    const list = await host.getMessages({ sessionId: 'demo-1' })
    expect(list.messages.find((m) => m.id === sent.messageId)!.files?.[0].path).toBe('E:/proj/src/a.ts')
  })

  it('形状非法 → `E_BAD_REQUEST` 拒整条（不是「照收但丢掉那一条」）', async () => {
    const host = createMockHostDataSource()
    const before = (await host.getMessages({ sessionId: 'demo-1' })).messages.length
    await expect(
      host.send({ sessionId: 'demo-1', text: 'x', files: [{ name: 'a.ts' } as never] }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    // 没有留下任何消息：失败是**整条**失败（与「发了但那条引用被丢掉」是两回事）
    expect((await host.getMessages({ sessionId: 'demo-1' })).messages).toHaveLength(before)
  })

  it('不带 `files` 时字段整个缺席（不为旧手机端凭空多出一个空数组）', async () => {
    const host = createMockHostDataSource()
    const sent = await host.send({ sessionId: 'demo-1', text: '普通一条' })
    const list = await host.getMessages({ sessionId: 'demo-1' })
    const message = list.messages.find((m) => m.id === sent.messageId)!
    expect('files' in message).toBe(false)
  })
})
