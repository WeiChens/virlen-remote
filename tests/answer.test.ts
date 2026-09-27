import { describe, it, expect } from 'vitest'
import { answerActionError, normalizeChoiceAnswer, CHOICE_JOINER } from '../src/index'

/**
 * 选择答案的规范化 —— 电脑侧桥接层、手机侧、mock 宿主共用这一份实现。
 * 它决定了「手机点了什么」最终以什么形态交给引擎（`ToolResult`），
 * 错了的表现是「AI 收到了内容，但消息渲染不出来（`uiData` 缺失）」。
 */
describe('normalizeChoiceAnswer', () => {
  it('对象形态（推荐）：选中项 + 自定义回复', () => {
    expect(normalizeChoiceAnswer({ selected: ['A', 'B'], customReply: '顺便看日志' })).toEqual({
      content: `A, B${CHOICE_JOINER}顺便看日志`,
      uiData: { selected: ['A', 'B'], customReply: '顺便看日志' },
    })
  })

  it('对象形态：仅选中项 / 仅自定义回复', () => {
    expect(normalizeChoiceAnswer({ selected: ['A'] })?.content).toBe('A')
    expect(normalizeChoiceAnswer({ customReply: '随便你' })).toEqual({
      content: '随便你',
      uiData: { selected: [], customReply: '随便你' },
    })
  })

  it('字符串 → 自定义回复；字符串数组 → 选中项（宽容解析）', () => {
    expect(normalizeChoiceAnswer('  就这样  ')).toEqual({
      content: '就这样',
      uiData: { selected: [], customReply: '就这样' },
    })
    expect(normalizeChoiceAnswer([' A ', '', 'B'])).toEqual({
      content: 'A, B',
      uiData: { selected: ['A', 'B'], customReply: '' },
    })
  })

  it('空结果一律拒绝（null）—— 不能给引擎发空回执', () => {
    expect(normalizeChoiceAnswer(undefined)).toBeNull()
    expect(normalizeChoiceAnswer('')).toBeNull()
    expect(normalizeChoiceAnswer('   ')).toBeNull()
    expect(normalizeChoiceAnswer([])).toBeNull()
    expect(normalizeChoiceAnswer({ selected: [], customReply: '   ' })).toBeNull()
    expect(normalizeChoiceAnswer({ selected: [1, 2] as unknown[] })).toBeNull()
    expect(normalizeChoiceAnswer(42)).toBeNull()
  })

  it('非字符串元素被剔除（防止把对象拼进 content）', () => {
    expect(normalizeChoiceAnswer({ selected: ['A', { x: 1 }] as unknown[] })?.uiData.selected).toEqual([
      'A',
    ])
  })
})

/**
 * 应答动作的合法性 —— **真实电脑侧（`interaction-registry`）与 mock 宿主共用这一份**。
 *
 * 钉死这张真值表的动机（2026-09-27 真机反馈）：手机对 AI 提问点「取消」曾被真实电脑端
 * 拒为 `unsupported-by-host`，而 mock 偏宽松、单测全绿 —— 「同一份语义两端各写一遍」的又一次代价。
 */
describe('answerActionError', () => {
  const choice = { kind: 'choice', presentation: 'modal' } as const
  const auth = { kind: 'authorization', presentation: 'modal' } as const
  const terminal = { kind: 'authorization', presentation: 'terminal' } as const

  it('提问：choose / deny / shelve 均合法；allow 无意义', () => {
    expect(answerActionError(choice, 'choose')).toBeNull()
    expect(answerActionError(choice, 'deny')).toBeNull()
    expect(answerActionError(choice, 'shelve')).toBeNull()
    expect(answerActionError(choice, 'allow')).toBe('unsupported-by-host')
  })

  it('授权：allow / deny / shelve 合法；choose 无意义', () => {
    expect(answerActionError(auth, 'allow')).toBeNull()
    expect(answerActionError(auth, 'deny')).toBeNull()
    expect(answerActionError(auth, 'shelve')).toBeNull()
    expect(answerActionError(auth, 'choose')).toBe('unsupported-by-host')
  })

  it('终端内确认：没有「暂存」语义（命令已就绪，只需放行或拒绝）', () => {
    expect(answerActionError(terminal, 'allow')).toBeNull()
    expect(answerActionError(terminal, 'deny')).toBeNull()
    expect(answerActionError(terminal, 'shelve')).toBe('unsupported-by-host')
  })
})
