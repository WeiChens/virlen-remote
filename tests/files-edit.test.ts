/**
 * 文本编辑（§37 覆写保存）的**共享契约**用例。
 *
 * 这一组盯的是「手机端改一个文件，电脑上那份文件的字节到底变成什么」：
 *
 * - 换行风格（CRLF 文件被编辑一次就整篇翻成 LF = diff 满屏红）；
 * - BOM（Windows 工具识别编码的唯一依据）；
 * - 非 UTF-8 的**拒编**（宽容解码出来的乱码存回去就是毁文件）；
 * - 覆写的三道闸（目标必须存在 / mtime+size 冲突 / 只收可编辑扩展名）与「不改名」。
 *
 * 契约层测这些的原因：这些规则**两端都要照做**（电脑侧独立校验一遍），
 * 各写一份的后果是「手机以为存上了、电脑上其实是 - 副本」这种谁也说不清的错位。
 */
import { describe, expect, it } from 'vitest'
import {
  FILE_EDIT_MAX_BYTES,
  applyEolStyle,
  bytesToBase64,
  decodeUtf8Strict,
  detectEolStyle,
  encodeEditedText,
  hasUtf8Bom,
  isEditableFileName,
  isEditableKind,
} from '../src/index'
import { createMockHostDataSource } from '../src/testing/index'

describe('可编辑范围（与预览共用同一张扩展名表）', () => {
  it('代码 / 配置 / 纯文本 / Markdown 可编辑', () => {
    for (const name of ['index.ts', 'App.tsx', 'main.rs', 'package.json', 'config.yaml', 'notes.txt', 'README.md', 'Makefile', '.gitignore']) {
      expect(isEditableFileName(name), name).toBe(true)
    }
    expect(isEditableKind('text')).toBe(true)
    expect(isEditableKind('markdown')).toBe(true)
  })

  it('图片与二进制不可编辑（前端不该出现入口，后端独立再拒一次）', () => {
    for (const name of ['logo.png', 'app.bin', 'archive.zip', 'doc.pdf', 'apphost']) {
      expect(isEditableFileName(name), name).toBe(false)
    }
    expect(isEditableKind('image')).toBe(false)
    expect(isEditableKind('binary')).toBe(false)
  })
})

describe('换行风格的往返（手机 textarea 只有 LF，Windows 文件多是 CRLF）', () => {
  it('按多数判定；没有换行时给 lf', () => {
    expect(detectEolStyle('a\r\nb\r\nc')).toBe('crlf')
    expect(detectEolStyle('a\nb\nc')).toBe('lf')
    expect(detectEolStyle('single line')).toBe('lf')
    // 混用时按多数（少数派的那几个换行不该把整篇翻过去）
    expect(detectEolStyle('a\r\nb\r\nc\nd')).toBe('crlf')
    expect(detectEolStyle('a\nb\nc\r\nd')).toBe('lf')
  })

  it('applyEolStyle 先把换行拉平再铺 —— 不会产出 `\\r\\r\\n`（那会是「保存一次多一堆空行」）', () => {
    expect(applyEolStyle('a\r\nb', 'crlf')).toBe('a\r\nb')
    expect(applyEolStyle('a\nb', 'crlf')).toBe('a\r\nb')
    // 单跑的 CR 也算换行（老 Mac 风格 / 混入的孤立 CR）
    expect(applyEolStyle('a\rb', 'lf')).toBe('a\nb')
    expect(applyEolStyle('a\r\nb', 'lf')).toBe('a\nb')
    expect(applyEolStyle('a\r\nb', 'crlf')).not.toContain('\r\r')
  })

  it('CRLF 文件编辑往返后仍是 CRLF（只改内容、不动行尾）', () => {
    const original = 'line1\r\nline2\r\nline3\r\n'
    // 手机端拿到的是「LF 化」的编辑区内容（HTML 规范：textarea 的 value 只有 LF）
    const edited = original.replace(/\r\n/g, '\n').replace('line2', 'line2 edited')
    const bytes = encodeEditedText(edited, { eol: detectEolStyle(original), bom: false })
    expect(new TextDecoder().decode(bytes)).toBe('line1\r\nline2 edited\r\nline3\r\n')
  })
})

describe('BOM 与编码（不合法 UTF-8 一律拒编）', () => {
  it('BOM 认得出、也保得住', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61])
    expect(hasUtf8Bom(bom)).toBe(true)
    expect(hasUtf8Bom(new TextEncoder().encode('a'))).toBe(false)
    const out = encodeEditedText('a', { eol: 'lf', bom: true })
    expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(out.length).toBe(4)
  })

  it('严格解码：合法 UTF-8（含中文）给文本，且剥掉 BOM', () => {
    const bytes = encodeEditedText('中文\nabc', { eol: 'lf', bom: true })
    expect(decodeUtf8Strict(bytes)).toBe('中文\nabc')
  })

  it('严格解码：GBK 字节 / 半截序列 → null（拿了 null 就不给编辑入口）', () => {
    // 「中文」的 GBK 编码（D6 D0 CE C4）不是合法 UTF-8
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeUtf8Strict(gbk)).toBeNull()
    // 被截断的多字节序列
    expect(decodeUtf8Strict(new Uint8Array([0xe4, 0xb8]))).toBeNull()
    // 纯 ASCII 仍然可以
    expect(decodeUtf8Strict(new TextEncoder().encode('plain'))).toBe('plain')
  })
})

/* ───────────────────────── 覆写（编辑保存）的整条链路 ───────────────────────── */

/** 走一遍「开始 → 分块 → 收尾」，返回收尾应答。 */
async function save(
  host: ReturnType<typeof createMockHostDataSource>,
  params: {
    sessionId: string
    dir?: string
    name: string
    bytes: Uint8Array
    expectMtimeMs?: number
    expectSize?: number
  },
) {
  const begin = await host.beginFileWrite({
    sessionId: params.sessionId,
    dir: params.dir ?? '',
    name: params.name,
    size: params.bytes.length,
    overwrite: true,
    ...(params.expectMtimeMs != null ? { expectMtimeMs: params.expectMtimeMs } : {}),
    ...(params.expectSize != null ? { expectSize: params.expectSize } : {}),
  })
  await host.writeFileChunk({
    uploadId: begin.uploadId,
    offset: 0,
    data: bytesToBase64(params.bytes),
  })
  return host.finishFileWrite({ uploadId: begin.uploadId })
}

describe('覆写已有文件（编辑保存）', () => {
  it('hello 如实声明 file.edit（不声明的话手机端只给只读预览）', async () => {
    const host = createMockHostDataSource()
    const hello = await host.hello!({
      protocolVersion: 1,
      client: { platform: 'test', appVersion: '0' },
      capabilities: [],
      token: 'demo-token',
    })
    expect(hello.capabilities).toContain('file.edit')
  })

  it('内容真的被换掉、路径不变、**不产生「 - 副本」**，并回一个新的 mtime', async () => {
    const host = createMockHostDataSource()
    const before = await host.readFile({ sessionId: 'demo-1', path: 'README.md' })
    const edit = new TextEncoder().encode('# 手机改过的标题\n')

    const done = await save(host, {
      sessionId: 'demo-1',
      name: 'README.md',
      bytes: edit,
      expectMtimeMs: before.mtimeMs,
      expectSize: before.size,
    })

    expect(done.relPath).toBe('README.md')
    expect(done.size).toBe(edit.length)
    expect(new TextDecoder().decode(host.readMockFile('demo-1', 'README.md')!)).toBe('# 手机改过的标题\n')
    // 改名口径只属于上传：覆写不该留下任何副本
    expect(host.listMockFiles('demo-1').filter((p) => p.includes('副本'))).toEqual([])
    // 回执里的 mtime 必须**已经变了**，否则手机端连改两次时第二次必然误判冲突
    expect(done.mtimeMs).toBeDefined()
    expect(done.mtimeMs).not.toBe(before.mtimeMs)

    // 用回执的 mtime 立刻再存一次：不该被判成冲突
    const second = new TextEncoder().encode('# 第二次\n')
    const again = await save(host, {
      sessionId: 'demo-1',
      name: 'README.md',
      bytes: second,
      expectMtimeMs: done.mtimeMs,
      expectSize: edit.length,
    })
    expect(again.size).toBe(second.length)
  })

  it('CRLF 原文件经手机编辑往返后仍是 CRLF（行尾不被整篇改写）', async () => {
    const host = createMockHostDataSource()
    host.writeMockFile('demo-1', 'src/win.bat', '@echo off\r\necho hi\r\n')
    const before = await host.readFile({ sessionId: 'demo-1', path: 'src/win.bat' })

    const bytes = encodeEditedText('@echo off\necho hi again\n', {
      eol: detectEolStyle('@echo off\r\necho hi\r\n'),
      bom: false,
    })
    await save(host, {
      sessionId: 'demo-1',
      name: 'win.bat',
      dir: 'src',
      bytes,
      expectMtimeMs: before.mtimeMs,
      expectSize: before.size,
    })

    const after = new TextDecoder().decode(host.readMockFile('demo-1', 'src/win.bat')!)
    expect(after).toBe('@echo off\r\necho hi again\r\n')
    expect(after).toContain('\r\n')
  })

  it('三道闸：目标必须存在 / mtime 不符即冲突 / size 不符即冲突', async () => {
    const host = createMockHostDataSource()
    const before = await host.readFile({ sessionId: 'demo-1', path: 'README.md' })
    const bytes = new TextEncoder().encode('x')

    // ① 不存在 → E_NOT_FOUND（**不新建**：手机端一个路径笔误不该在目录里造出文件）
    await expect(
      save(host, { sessionId: 'demo-1', name: 'nope.txt', bytes }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })

    // ② 期间电脑侧改过它 → 冲突，且**原文件一字未动**
    const original = host.readMockFile('demo-1', 'README.md')!.slice()
    host.writeMockFile('demo-1', 'README.md', '# AI 在电脑上改过了\n')
    await expect(
      save(host, {
        sessionId: 'demo-1',
        name: 'README.md',
        bytes,
        expectMtimeMs: before.mtimeMs,
      }),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' })
    expect(new TextDecoder().decode(host.readMockFile('demo-1', 'README.md')!)).toBe(
      '# AI 在电脑上改过了\n',
    )

    // ③ size 对不上（哪怕 mtime 恰好相同）也拒
    const fresh = await host.readFile({ sessionId: 'demo-1', path: 'README.md' })
    await expect(
      save(host, {
        sessionId: 'demo-1',
        name: 'README.md',
        bytes,
        expectMtimeMs: fresh.mtimeMs,
        expectSize: fresh.size + 1,
      }),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' })
    expect(original.length).toBeGreaterThan(0)
  })

  it('只收可编辑的扩展名 / 编辑上限单独夹一次（比上传上限严得多）', async () => {
    const host = createMockHostDataSource()
    const bytes = new TextEncoder().encode('x')
    // 二进制文件不给改（手机端根本没有入口，这里验的是「电脑侧也会拒」）
    await expect(
      save(host, { sessionId: 'demo-1', name: 'app.bin', dir: 'build', bytes }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })

    // 编辑上限（256KB）比上传上限（32MB）严 —— 超了就在开始前拒，别让手机上白传一遍
    await expect(
      save(host, {
        sessionId: 'demo-1',
        name: 'README.md',
        bytes: new Uint8Array(FILE_EDIT_MAX_BYTES + 1),
      }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
  })

  it('中途放弃：原文件保持原样（临时态不落盘）', async () => {
    const host = createMockHostDataSource()
    const before = host.readMockFile('demo-1', 'README.md')!.slice()
    const begin = await host.beginFileWrite({
      sessionId: 'demo-1',
      name: 'README.md',
      size: 5,
      overwrite: true,
    })
    await host.writeFileChunk({ uploadId: begin.uploadId, offset: 0, data: bytesToBase64(new TextEncoder().encode('half!')) })
    await host.abortFileWrite({ uploadId: begin.uploadId })
    expect([...host.readMockFile('demo-1', 'README.md')!]).toEqual([...before])
    await expect(host.finishFileWrite({ uploadId: begin.uploadId })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
  })
})
