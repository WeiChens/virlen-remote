/**
 * `summarizeToolArgs` 单测 —— 「工具泡里那行入参摘要」的格式化口径。
 *
 * 为什么值得一组单测：这段文案是**两端共用的唯一一份**（真实电脑侧 `bridge/dto.ts` 与
 * 演示宿主 `testing/mock-host.ts` 都调它），它出错的表现不是报错，而是「手机上少显示一个
 * 文件路径」这种没人会当成 bug 的静默退化 —— 或者更糟：把 `write_file.content` 整篇文章
 * 当成摘要下行（流量事故）。
 *
 * 用例按三条纪律组织：
 * 1. 键名以 `tool_defs/definitions.json` 为准（每个工具挑得出主参数）；
 * 2. 拿不到就不猜（返回 `undefined`，手机端只显示工具名）；
 * 3. 只给摘要不给原文（长度硬上限 + 长内容只报行数）。
 */
import { describe, expect, it } from 'vitest'
import {
  TOOL_ARGS_MAX,
  TOOL_DETAIL_MAX,
  elideMiddle,
  formatToolArgs,
  summarizeToolArgs,
} from '../src/protocol/tool-args'

describe('summarizeToolArgs —— 各工具的主参数', () => {
  it('单路径工具：给出路径（read_file 还带上行区间）', () => {
    expect(summarizeToolArgs('read_file', { path: 'src/store/chat.ts' })).toBe('src/store/chat.ts')
    expect(
      summarizeToolArgs('read_file', { path: 'src/a.ts', start_line: 12, max_lines: 29 }),
    ).toBe('src/a.ts 12-40')
    expect(summarizeToolArgs('vision_analyze', { path: 'shots/a.png' })).toBe('shots/a.png')
    expect(summarizeToolArgs('file_info', { path: 'README.md' })).toBe('README.md')
  })

  it('数组路径：首项 + 剩余数量（桌面也只报首项与总数）', () => {
    expect(summarizeToolArgs('read_file', { paths: ['a.ts', 'b.ts', 'c.ts'] })).toBe('a.ts +2')
    expect(summarizeToolArgs('mkdir', { paths: ['src/x', 'src/y'] })).toBe('src/x +1')
    expect(summarizeToolArgs('delete_file', { path: 'tmp.log' })).toBe('tmp.log')
  })

  it('execute_command：就是那条命令（多行压成一行）', () => {
    expect(summarizeToolArgs('execute_command', { command: 'npm run build', tips: '构建' })).toBe(
      'npm run build',
    )
    expect(
      summarizeToolArgs('execute_command', { command: 'cd src\ngit status' }),
    ).toBe('cd src git status')
  })

  it('execute_script：给脚本路径，不给脚本正文', () => {
    expect(
      summarizeToolArgs('execute_script', {
        file_path: 'temp/run.ps1',
        file_content: 'Write-Output 1\nWrite-Output 2',
        command: 'powershell -File .\\temp\\run.ps1',
      }),
    ).toBe('temp/run.ps1')
  })

  it('搜索类：沿用桌面句式「在 X 中搜索 Y」（缺哪半边就用另一半）', () => {
    expect(
      summarizeToolArgs('search_text_in_files', { path: 'src', query: 'sessionError' }),
    ).toBe('在 src 中搜索 sessionError')
    expect(summarizeToolArgs('search_files_by_name', { query: '*.test.ts' })).toBe('*.test.ts')
    expect(summarizeToolArgs('web_search', { query: 'tauri v2' })).toBe('tauri v2')
  })

  it('copy_move_file：源 → 目标', () => {
    expect(
      summarizeToolArgs('copy_move_file', { source: 'a/b.ts', destination: 'c/d.ts', mode: 'copy' }),
    ).toBe('a/b.ts → c/d.ts')
  })

  it('todo_write：只说改了几项（清单内容在浮层里看，与桌面同一句文案）', () => {
    expect(summarizeToolArgs('todo_write', { todos: [{}, {}, {}] })).toBe('更新了 3 项任务')
  })
})

describe('summarizeToolArgs —— 只给摘要，不给原文', () => {
  it('write_file 不带上正文，只报行数', () => {
    const content = Array.from({ length: 120 }, (_, i) => `第 ${i} 行`).join('\n')
    const summary = summarizeToolArgs('write_file', { path: 'src/a.ts', content })
    expect(summary).toBe('src/a.ts · 写入 120 行')
    expect(summary).not.toContain('第 0 行')
  })

  it('edit_file 报改动规模（与桌面降级分支同一套算法与文案）', () => {
    expect(
      summarizeToolArgs('edit_file', {
        path: 'src/a.ts',
        edits: [
          { old_string: 'a\nb', new_string: 'a\nb\nc' },
          { old_string: 'x', new_string: 'y\nz' },
        ],
      }),
    ).toBe('src/a.ts · 减少 3行,新增 5行')
    // 老形状（单次编辑，不在 edits 数组里）也认
    expect(
      summarizeToolArgs('edit_file', { path: 'src/a.ts', old_string: 'x', new_string: 'y' }),
    ).toBe('src/a.ts · 减少 1行,新增 1行')
  })

  it('超长摘要截断到硬上限（长命令不能把帧撑大）', () => {
    const command = 'echo ' + 'x'.repeat(500)
    const summary = summarizeToolArgs('execute_command', { command })!
    expect(summary.length).toBe(TOOL_ARGS_MAX + 1) // 截断后带一个省略号
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('summarizeToolArgs —— 拿不到就不猜', () => {
  it('没有可用入参 → undefined（手机端只显示工具名）', () => {
    expect(summarizeToolArgs('list_skills', {})).toBeUndefined()
    expect(summarizeToolArgs('get_current_time', {})).toBeUndefined()
    expect(summarizeToolArgs('read_file', { path: '   ' })).toBeUndefined()
    expect(summarizeToolArgs('execute_command', { command: 42 })).toBe('42')
  })

  it('未知工具：按兜底键序取一个，都没有就「键=值」（最多两个）', () => {
    expect(summarizeToolArgs('future_tool', { path: 'src/a.ts', extra: 'x' })).toBe('src/a.ts')
    expect(summarizeToolArgs('future_tool', { foo: '1', bar: '2', baz: '3' })).toBe('foo=1 bar=2')
    expect(summarizeToolArgs('future_tool', { nested: { a: 1 } })).toBeUndefined()
  })

  it('JSON 字符串入参（老数据）也能解析', () => {
    expect(summarizeToolArgs('read_file', '{"path":"src/a.ts"}')).toBe('src/a.ts')
    expect(summarizeToolArgs('read_file', '{ 这不是 JSON')).toBeUndefined()
  })

  it('shortenPath：电脑侧把绝对路径缩成工作目录相对路径（演示宿主不传就原样）', () => {
    const shortenPath = (p: string): string => p.replace('E:/long/workspace/', '')
    expect(summarizeToolArgs('read_file', { path: 'E:/long/workspace/src/a.ts' }, { shortenPath })).toBe(
      'src/a.ts',
    )
    expect(summarizeToolArgs('read_file', { path: 'E:/long/workspace/src/a.ts' })).toBe(
      'E:/long/workspace/src/a.ts',
    )
  })
})

// ─────────────────── formatToolArgs —— 展开态的完整入参 ───────────────────

describe('formatToolArgs —— 展开区的完整入参', () => {
  it('两空格缩进的 JSON（与桌面导出 `JSON.stringify(input, null, 2)` 同一形态）', () => {
    expect(formatToolArgs({ path: 'src/a.ts', start_line: 12 })).toBe(
      '{\n  "path": "src/a.ts",\n  "start_line": 12\n}',
    )
  })

  it('路径键的值按工作目录缩短：数组、嵌套、非路径键都分清', () => {
    const shortenPath = (p: string): string => p.replace('E:/code/demo/', '')
    expect(
      formatToolArgs(
        {
          path: 'E:/code/demo/README.md',
          paths: ['E:/code/demo/src/a.ts', 'E:/code/demo/src/b.ts'],
          // `command` 不是路径键：里面的绝对路径原样（它是一整条命令，不是路径）
          command: 'cd E:/code/demo && ls',
        },
        { shortenPath },
      ),
    ).toBe(
      [
        '{',
        '  "path": "README.md",',
        '  "paths": [',
        '    "src/a.ts",',
        '    "src/b.ts"',
        '  ],',
        '  "command": "cd E:/code/demo && ls"',
        '}',
      ].join('\n'),
    )
  })

  it('完整入参**允许**出现正文（与摘要的纪律相反），但总量被上限兜住', () => {
    const content = Array.from({ length: 2000 }, (_, i) => `第 ${i} 行内容`).join('\n')
    const detail = formatToolArgs({ path: 'src/big.ts', content })!
    expect(detail).toContain('第 0 行内容') // 头在
    expect(detail).toContain('第 1999 行内容') // 尾也在（结论常在这里）
    expect(detail).toContain('（中间省略')
    expect(detail.length).toBeLessThanOrEqual(TOOL_DETAIL_MAX)
  })

  it('JSON 字符串入参解开；解不开的原样给（展开区是现场，藏起来更糟）', () => {
    expect(formatToolArgs('{"path":"src/a.ts"}')).toBe('{\n  "path": "src/a.ts"\n}')
    expect(formatToolArgs('{ 这不是 JSON')).toBe('{ 这不是 JSON')
    expect(formatToolArgs('  git status  ')).toBe('git status')
  })

  it('没有可显示的内容 → undefined（展开区不渲染这一块）', () => {
    expect(formatToolArgs(undefined)).toBeUndefined()
    expect(formatToolArgs('')).toBeUndefined()
    expect(formatToolArgs('   ')).toBeUndefined()
    // 无参数的工具（`get_current_time`）：摆一个 `{}` 只占地方，还像漏显示了什么
    expect(formatToolArgs({})).toBeUndefined()
  })
})

// ─────────────────── elideMiddle —— 头尾都留的中间省略 ───────────────────

describe('elideMiddle —— 头尾都留，挖掉中间', () => {
  it('没超上限就原样返回（不做任何加工）', () => {
    expect(elideMiddle('abc', 10)).toBe('abc')
  })

  it('超上限：头尾都在、标记带真实省略数、结果不超上限', () => {
    const text = 'A'.repeat(3000) + 'B'.repeat(3000)
    const out = elideMiddle(text, 500)
    expect(out.length).toBeLessThanOrEqual(500)
    expect(out.startsWith('A')).toBe(true)
    expect(out.endsWith('B')).toBe(true)
    const mark = /…（中间省略 (\d+) 字符）…/.exec(out)
    expect(mark).not.toBeNull()
    // 标记前后各两个换行；被挖掉的数必须是真的（掐指一算就对不上的是「会骗人的截断」）
    const kept = out.length - mark![0].length - 4
    expect(Number(mark![1])).toBe(text.length - kept)
  })

  it('上限为 0 / 负数 → 空串（不抛，也不返回一个「看起来有内容」的东西）', () => {
    expect(elideMiddle('abc', 0)).toBe('')
    expect(elideMiddle('abc', -1)).toBe('')
  })
})
