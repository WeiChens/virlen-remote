import { describe, it, expect } from 'vitest'
import {
  Endpoint,
  FILE_DIRECT_ONLY_MESSAGE,
  FILE_CHUNK_BYTES,
  FILE_UPLOAD_MAX_BYTES,
  baseNameOfPath,
  base64ToBytes,
  bytesToBase64,
  compareFileEntries,
  createCaller,
  createMemoryPair,
  duplicateNameCandidate,
  fileTransferDeniedReason,
  formatFileSize,
  isSafeEntryName,
  joinRelPath,
  mimeTypeOf,
  normalizeRelPath,
  parentOfRelPath,
  previewKindOf,
  previewLimitOf,
  registerHostHandlers,
  splitNameExt,
  type FileEntryDTO,
  type HostApi,
} from '../src/index'
import { createMockHostDataSource, type MockHostDataSource } from '../src/testing/index'

/* ───────────────────────── 纯函数：预览分类 / 限额 / MIME ───────────────────────── */

describe('文件分类（两端唯一口径）', () => {
  it('按扩展名分类：代码 / 标记 / 图片 / 未知', () => {
    expect(previewKindOf('index.ts')).toBe('text')
    expect(previewKindOf('App.tsx')).toBe('text')
    expect(previewKindOf('package.json')).toBe('text')
    expect(previewKindOf('config.yaml')).toBe('text')
    expect(previewKindOf('README.md')).toBe('markdown')
    expect(previewKindOf('logo.PNG')).toBe('image')
    expect(previewKindOf('icon.svg')).toBe('image')
    // 未知扩展名 → binary（只给下载）——保守侧必须是「不渲染」，否则屏幕上是一堆乱码
    expect(previewKindOf('app.bin')).toBe('binary')
    expect(previewKindOf('archive.zip')).toBe('binary')
    expect(previewKindOf('')).toBe('binary')
  })

  it('无扩展名的常见文本文件名照样认得出（含前导点）', () => {
    expect(previewKindOf('Makefile')).toBe('text')
    expect(previewKindOf('Dockerfile')).toBe('text')
    expect(previewKindOf('.gitignore')).toBe('text')
    expect(previewKindOf('LICENSE')).toBe('text')
    // 不在白名单里的无扩展名文件仍按 binary（不猜）
    expect(previewKindOf('apphost')).toBe('binary')
  })

  it('预览上限：文本 1MB / 图片 8MB / 二进制不可预览', () => {
    expect(previewLimitOf('text')).toBe(1024 * 1024)
    expect(previewLimitOf('markdown')).toBe(1024 * 1024)
    expect(previewLimitOf('image')).toBe(8 * 1024 * 1024)
    expect(previewLimitOf('binary')).toBe(0)
  })

  it('MIME：认得出给真类型，认不出给 octet-stream（浏览器据此下载而不是渲染）', () => {
    expect(mimeTypeOf('a.png')).toBe('image/png')
    expect(mimeTypeOf('a.md')).toBe('text/markdown')
    expect(mimeTypeOf('a.zip')).toBe('application/zip')
    expect(mimeTypeOf('a.unknown')).toBe('application/octet-stream')
    expect(mimeTypeOf('noext')).toBe('application/octet-stream')
  })

  it('formatFileSize 与电脑侧工具输出同一套进位', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(Number.NaN)).toBe('—')
  })
})

/* ───────────────────────── base64 往返 ───────────────────────── */

describe('base64（零依赖，两端同一条码路）', () => {
  it('往返：长度 0..8 与几千字节（跨分块边界）', () => {
    for (let n = 0; n <= 8; n++) {
      const bytes = new Uint8Array(n)
      for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 11) & 0xff
      expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes])
    }
    // 跨 3 字节分组的边界（含补齐）+ 接近单块上限的量级
    for (const size of [4095, 4096, 4097, 300 * 1024]) {
      const bytes = new Uint8Array(size)
      for (let i = 0; i < size; i++) bytes[i] = (i * 131 + 7) & 0xff
      const round = base64ToBytes(bytesToBase64(bytes))
      expect(round.length).toBe(size)
      let same = true
      for (let i = 0; i < size; i++) {
        if (round[i] !== bytes[i]) {
          same = false
          break
        }
      }
      expect(same).toBe(true)
    }
  })

  it('补齐规则与已知向量', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('')
    expect(bytesToBase64(new TextEncoder().encode('f'))).toBe('Zg==')
    expect(bytesToBase64(new TextEncoder().encode('fo'))).toBe('Zm8=')
    expect(bytesToBase64(new TextEncoder().encode('foo'))).toBe('Zm9v')
    expect(new TextDecoder().decode(base64ToBytes('5L2g5aW9'))).toBe('你好')
  })

  it('容忍缺失的 = 补位，但不容忍非法字符（静默容错会变成查不出来的坏文件）', () => {
    expect(new TextDecoder().decode(base64ToBytes('Zg'))).toBe('f')
    expect(new TextDecoder().decode(base64ToBytes('Zm8'))).toBe('fo')
    expect(() => base64ToBytes('Zm9v*')).toThrow()
    // 长度模 4 余 1 是不可能的 base64（必是数据被截断）
    expect(() => base64ToBytes('Zm9vZ')).toThrow()
  })
})

/* ───────────────────────── 路径工具与文件名 ───────────────────────── */

describe('相对路径工具（形状可控，真正拒绝在电脑侧）', () => {
  it('规整：反斜杠 / 前导斜杠 / ./ / .. 逃逸', () => {
    expect(normalizeRelPath('src/store')).toBe('src/store')
    expect(normalizeRelPath('\\src\\store\\')).toBe('src/store')
    expect(normalizeRelPath('/src//store')).toBe('src/store')
    expect(normalizeRelPath('./src/./a.ts')).toBe('src/a.ts')
    expect(normalizeRelPath('')).toBe('')
    // 逃出工作目录的段被就地吃掉 → 变成一个「明确不存在」的路径，而不是含糊的穿越
    expect(normalizeRelPath('../../etc/passwd')).toBe('etc/passwd')
    expect(normalizeRelPath('src/../../outside')).toBe('outside')
  })

  it('拼接 / 取父 / 取末级', () => {
    expect(joinRelPath('', 'a.txt')).toBe('a.txt')
    expect(joinRelPath('src', 'a.txt')).toBe('src/a.txt')
    expect(joinRelPath('src/', '/a.txt')).toBe('src/a.txt')
    expect(parentOfRelPath('src/store/a.ts')).toBe('src/store')
    expect(parentOfRelPath('a.ts')).toBe('')
    expect(parentOfRelPath('')).toBe('')
    expect(baseNameOfPath('src/store/a.ts')).toBe('a.ts')
    expect(baseNameOfPath('')).toBe('')
  })

  it('文件名合法性：分隔符 / 保留字符 / 结尾点空格 / 超长一律拒', () => {
    expect(isSafeEntryName('a.txt')).toBe(true)
    expect(isSafeEntryName('中文 文件名.md')).toBe(true)
    expect(isSafeEntryName('')).toBe(false)
    expect(isSafeEntryName('.')).toBe(false)
    expect(isSafeEntryName('..')).toBe(false)
    expect(isSafeEntryName('a/b.txt')).toBe(false)
    expect(isSafeEntryName('a\\b.txt')).toBe(false)
    expect(isSafeEntryName('a:b.txt')).toBe(false)
    expect(isSafeEntryName('trailing.')).toBe(false)
    expect(isSafeEntryName('trailing ')).toBe(false)
    expect(isSafeEntryName('x'.repeat(201))).toBe(false)
  })

  it('冲突消解名与桌面侧同一条口径', () => {
    expect(duplicateNameCandidate('a.txt', 1)).toBe('a - 副本.txt')
    expect(duplicateNameCandidate('a.txt', 2)).toBe('a - 副本 (2).txt')
    expect(duplicateNameCandidate('Makefile', 1)).toBe('Makefile - 副本')
    expect(splitNameExt('a.tar.gz')).toEqual({ base: 'a.tar', ext: 'gz' })
    expect(splitNameExt('.gitignore')).toEqual({ base: '.gitignore', ext: '' })
  })

  it('目录在前、同层按名称（两端同一排序）', () => {
    const list: FileEntryDTO[] = [
      { name: 'b.ts', isDir: false, size: 1 },
      { name: 'src', isDir: true, size: 0 },
      { name: 'A.md', isDir: false, size: 1 },
      { name: 'docs', isDir: true, size: 0 },
    ]
    expect([...list].sort(compareFileEntries).map((e) => e.name)).toEqual(['docs', 'src', 'A.md', 'b.ts'])
  })
})

/* ───────────────────────── 非中继门槛（两端同一句话） ───────────────────────── */

describe('非中继门槛', () => {
  it('只有确认走了 TURN 中继才拒；unknown 放行（拿不准不等于禁用）', () => {
    expect(fileTransferDeniedReason('relay')).toBe(FILE_DIRECT_ONLY_MESSAGE)
    expect(fileTransferDeniedReason('direct')).toBeNull()
    // unknown 是常态（Broadcast 联调 / 非 WebRTC 链路 / 刚打通那几秒）——判成禁用就是「坏掉」
    expect(fileTransferDeniedReason('unknown')).toBeNull()
    expect(fileTransferDeniedReason(undefined)).toBeNull()
    expect(fileTransferDeniedReason(null)).toBeNull()
  })
})

/* ───────────────────────── 端到端：mock 宿主 ───────────────────────── */

/** 一串确定性字节（用于验证分块读写的字节级一致）。 */
function makeBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = (i * 97 + 13) & 0xff
  return bytes
}

describe('mock 宿主的文件能力（演示树 + 分块读写）', () => {
  it('列目录：根 → 子目录 → 不存在；absPath 由电脑侧拼好', async () => {
    const host = createMockHostDataSource()
    const root = await host.listFiles({ sessionId: 'demo-1' })
    expect(root.relPath).toBe('')
    expect(root.absPath).toBe('E:/code/virlen-demo')
    expect(root.entries.map((e) => e.name)).toEqual([
      'assets',
      'build',
      'docs',
      'src',
      '.gitignore',
      'package.json',
      'README.md',
    ])
    // 目录在前
    expect(root.entries[0].isDir).toBe(true)

    const src = await host.listFiles({ sessionId: 'demo-1', path: 'src' })
    expect(src.relPath).toBe('src')
    expect(src.absPath).toBe('E:/code/virlen-demo/src')
    expect(src.entries.map((e) => e.name)).toEqual(['store', 'app.ts', 'index.ts'])
    expect(src.entries.find((e) => e.name === 'index.ts')?.size).toBeGreaterThan(0)

    await expect(host.listFiles({ sessionId: 'demo-1', path: 'nope' })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
    await expect(host.listFiles({ sessionId: 'ghost' })).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })

  it('越权路径被规整成不存在的路径（E_NOT_FOUND，而不是含糊的穿越）', async () => {
    const host = createMockHostDataSource()
    await expect(host.listFiles({ sessionId: 'demo-1', path: '../../../Windows' })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
    await expect(host.readFile({ sessionId: 'demo-1', path: '../../etc/passwd' })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
  })

  it('读文件：首块给全量大小与分类，分块拼起来与源字节一致', async () => {
    const host = createMockHostDataSource()
    const content = makeBytes(FILE_CHUNK_BYTES + 777)
    host.writeMockFile('demo-1', 'docs/big.log', content)

    const first = await host.readFile({ sessionId: 'demo-1', path: 'docs/big.log', length: 1024 })
    expect(first.offset).toBe(0)
    expect(first.size).toBe(content.length)
    expect(first.kind).toBe('text')
    expect(first.mime).toBe('text/plain')
    expect(first.eof).toBe(false)
    expect(base64ToBytes(first.data).length).toBe(1024)

    // 逐块读到 eof，拼起来必须等于源字节（分块实现的恒等式）
    const parts: Uint8Array[] = [base64ToBytes(first.data)]
    let offset = 1024
    for (;;) {
      const chunk = await host.readFile({ sessionId: 'demo-1', path: 'docs/big.log', offset })
      parts.push(base64ToBytes(chunk.data))
      offset += base64ToBytes(chunk.data).length
      if (chunk.eof) break
      // 单块不得越过上限
      expect(chunk.data.length).toBeLessThanOrEqual(Math.ceil((FILE_CHUNK_BYTES * 4) / 3))
    }
    const merged = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      merged.set(p, at)
      at += p.length
    }
    expect([...merged]).toEqual([...content])
  })

  it('读文件：图片按 image 分类、未知扩展名按 binary（只能下载）', async () => {
    const host = createMockHostDataSource()
    const png = await host.readFile({ sessionId: 'demo-1', path: 'assets/logo.png' })
    expect(png.kind).toBe('image')
    expect(png.mime).toBe('image/png')
    expect(png.eof).toBe(true)
    // 演示树里放的是**真** PNG 字节（不是一段被改名成 .png 的文本）——验字节签名而不是字节数
    expect([...base64ToBytes(png.data).subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])

    const bin = await host.readFile({ sessionId: 'demo-1', path: 'build/app.bin' })
    expect(bin.kind).toBe('binary')
    expect(bin.mime).toBe('application/octet-stream')

    await expect(host.readFile({ sessionId: 'demo-1', path: 'src' })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
  })

  it('上传：分块 → 落盘；同名自动「 - 副本」；abort 不留痕迹', async () => {
    const host = createMockHostDataSource()
    const data = makeBytes(300 * 1024)

    const begin = await host.beginFileWrite({
      sessionId: 'demo-1',
      dir: 'docs',
      name: 'upload.bin',
      size: data.length,
    })
    expect(begin.name).toBe('upload.bin')
    expect(begin.relPath).toBe('docs/upload.bin')

    let sent = 0
    while (sent < data.length) {
      const slice = data.subarray(sent, sent + FILE_CHUNK_BYTES)
      const res = await host.writeFileChunk({
        uploadId: begin.uploadId,
        offset: sent,
        data: bytesToBase64(slice),
      })
      sent += slice.length
      expect(res.received).toBe(sent)
    }
    const finished = await host.finishFileWrite({ uploadId: begin.uploadId })
    expect(finished).toMatchObject({ name: 'upload.bin', relPath: 'docs/upload.bin', size: data.length })
    expect([...(host.readMockFile('demo-1', 'docs/upload.bin') ?? [])]).toEqual([...data])
    expect(host.listMockFiles('demo-1')).toContain('docs/upload.bin')

    // 同名再来一次 → 加「 - 副本」（与桌面侧文件操作同一条口径）
    const again = await host.beginFileWrite({
      sessionId: 'demo-1',
      dir: 'docs',
      name: 'upload.bin',
      size: 3,
    })
    expect(again.name).toBe('upload - 副本.bin')
    await host.writeFileChunk({ uploadId: again.uploadId, offset: 0, data: bytesToBase64(makeBytes(3)) })
    await host.finishFileWrite({ uploadId: again.uploadId })
    expect(host.listMockFiles('demo-1')).toContain('docs/upload - 副本.bin')

    // 中途放弃：临时态不落盘（用户项目里不该出现半截文件）
    const aborted = await host.beginFileWrite({
      sessionId: 'demo-1',
      dir: '',
      name: 'half.txt',
      size: 10,
    })
    await host.writeFileChunk({ uploadId: aborted.uploadId, offset: 0, data: bytesToBase64(makeBytes(4)) })
    await host.abortFileWrite({ uploadId: aborted.uploadId })
    expect(host.listMockFiles('demo-1')).not.toContain('half.txt')
    await expect(host.finishFileWrite({ uploadId: aborted.uploadId })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
  })

  it('上传的几道闸：超限 / 非法名 / 目录不存在 / 乱序 / 未传完 / 冲突策略 reject', async () => {
    const host = createMockHostDataSource()

    await expect(
      host.beginFileWrite({ sessionId: 'demo-1', name: 'big.bin', size: FILE_UPLOAD_MAX_BYTES + 1 }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    await expect(
      host.beginFileWrite({ sessionId: 'demo-1', name: 'a/b.txt', size: 1 }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    await expect(
      host.beginFileWrite({ sessionId: 'demo-1', dir: 'nope', name: 'a.txt', size: 1 }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })

    const begin = await host.beginFileWrite({ sessionId: 'demo-1', name: 'order.txt', size: 6 })
    await expect(
      host.writeFileChunk({ uploadId: begin.uploadId, offset: 3, data: bytesToBase64(makeBytes(3)) }),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' })
    await host.writeFileChunk({ uploadId: begin.uploadId, offset: 0, data: bytesToBase64(makeBytes(3)) })
    // 只传了一半就收尾 → 拒，不落盘
    await expect(host.finishFileWrite({ uploadId: begin.uploadId })).rejects.toMatchObject({
      code: 'E_BAD_REQUEST',
    })
    expect(host.listMockFiles('demo-1')).not.toContain('order.txt')

    await expect(
      host.beginFileWrite({
        sessionId: 'demo-1',
        name: 'README.md',
        size: 1,
        onConflict: 'reject',
      }),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' })
  })

  it('非中继：所有文件方法一律拒（同一句话）；但 abort 仍放行（只做清理）', async () => {
    const host = createMockHostDataSource({ fileLinkKind: 'relay' })
    for (const call of [
      () => host.listFiles({ sessionId: 'demo-1' }),
      () => host.readFile({ sessionId: 'demo-1', path: 'README.md' }),
      () => host.beginFileWrite({ sessionId: 'demo-1', name: 'a.txt', size: 1 }),
      () => host.writeFileChunk({ uploadId: 'x', offset: 0, data: '' }),
      () => host.finishFileWrite({ uploadId: 'x' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'E_DENIED', message: FILE_DIRECT_ONLY_MESSAGE })
    }
    // 清理例外：链路被换成中继时，临时文件仍必须能被清掉
    await expect(host.abortFileWrite({ uploadId: 'x' })).resolves.toEqual({ ok: true })
  })
})

/* ───────────────────────── 端到端：经 Endpoint 分发 ───────────────────────── */

describe('host.file.* 的注册与分发（memory transport，不依赖 WebRTC）', () => {
  it('手机端 caller 能列目录 / 读分块 / 上传并落盘', async () => {
    const [a, b] = createMemoryPair()
    const hostEp = new Endpoint({ transport: a })
    const clientEp = new Endpoint({ transport: b })
    const source: MockHostDataSource = createMockHostDataSource()
    const reg = registerHostHandlers(hostEp, source)
    source.bind(reg.emit)
    const caller = createCaller<HostApi>(clientEp)

    const hello = await caller.call('host.hello', {
      protocolVersion: 1,
      client: { platform: 'test', appVersion: '0' },
      capabilities: [],
      token: 'demo-token',
    })
    expect(hello.capabilities).toContain('file.browse')
    expect(hello.capabilities).toContain('file.download')
    expect(hello.capabilities).toContain('file.upload')

    const page = await caller.call('host.file.list', { sessionId: 'demo-1' })
    expect(page.entries.some((e) => e.name === 'src' && e.isDir)).toBe(true)

    const chunk = await caller.call('host.file.read', { sessionId: 'demo-1', path: 'README.md' })
    expect(chunk.kind).toBe('markdown')
    const text = new TextDecoder().decode(base64ToBytes(chunk.data))
    expect(text.startsWith('# Virlen 演示项目')).toBe(true)

    const payload = makeBytes(5000)
    const begin = await caller.call('host.file.write.begin', {
      sessionId: 'demo-1',
      dir: 'docs',
      name: 'from-phone.txt',
      size: payload.length,
    })
    let sent = 0
    while (sent < payload.length) {
      const slice = payload.subarray(sent, sent + FILE_CHUNK_BYTES)
      await caller.call('host.file.write.chunk', {
        uploadId: begin.uploadId,
        offset: sent,
        data: bytesToBase64(slice),
      })
      sent += slice.length
    }
    await caller.call('host.file.write.finish', { uploadId: begin.uploadId })
    expect([...(source.readMockFile('demo-1', 'docs/from-phone.txt') ?? [])]).toEqual([...payload])

    reg.dispose()
    hostEp.dispose()
    clientEp.dispose()
    a.close()
    b.close()
  })
})
