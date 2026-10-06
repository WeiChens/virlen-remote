/**
 * 工作目录文件访问的**共享契约** —— 「手机端看电脑上的文件」这件事的口径只有这一份。
 *
 * 为什么单开一个文件（而不是塞进 `api.ts`）：这里的东西**两端都要用同一份**，且大多与
 * RPC 形状无关 —— 预览分类、分块大小、base64 编解码、相对路径工具。两端口径一旦分叉，
 * 症状是「电脑说这是文本、手机按二进制显示」这类谁也说不清的错位。
 *
 * ## 分工（谁说话算数）
 *
 * - **电脑侧**是权威：文件类型、MIME、大小、是否存在、最终落盘名，全由它给；
 * - **手机侧不猜**：不按扩展名自己挑渲染器以外的判断（分类函数在两边跑同一份，只是为了让
 *   手机能在**下载**时判断「多大才值得下」，以及给出行内文案）；
 * - **安全边界不在本文件**：真正确认「这个路径能不能碰」的是电脑侧的
 *   `securityService.resolveSafePath`（会话工作目录 + 黑白名单）。这里的路径工具只负责
 *   *把手机传来的相对路径规整成可控的形状*（去掉 `\\`、`./`、前导 `/` 与 `..` 段）。
 *
 * ## 传输形态（为什么是 base64 分块）
 *
 * 帧层是「12KB 分片的 UTF-8 JSON」（见 `frame.ts`），**没有二进制帧**。一条逻辑消息要
 * 攒齐所有分片才会交付给上层，所以把整个文件塞进一次 RPC = 让对端在内存里拼一个巨型字符串。
 * 于是文件字节走**应用层分块**：每次 RPC 传 `FILE_CHUNK_BYTES` 字节（base64 后 ~350KB 文本），
 * 手机端拼成 Blob。代价是 base64 的 33% 开销；换来的是：进度可见、随时可取消、
 * 单次请求的内存上界固定、且**不需要改帧格式**（不必升协议主版本）。
 */

// ───────────────────────────── 能力名 ─────────────────────────────

/**
 * 列目录 + 读文件元信息（`host.file.list`）。
 *
 * ⚠️ 三个能力名里**它是最低门槛**（要能下载就得先能列目录），但不合并成一个：
 * 「只看不改」与「能往我项目里写文件」是两种授权强度，用户可能只想给前者。
 */
export const FILE_BROWSE_CAPABILITY = 'file.browse'
/** 读取文件内容（`host.file.read`，预览与下载都走它）。 */
export const FILE_DOWNLOAD_CAPABILITY = 'file.download'
/** 上传（`host.file.write.*`）—— 往工作目录里**新增**一个文件，与只读两档分开。 */
export const FILE_UPLOAD_CAPABILITY = 'file.upload'

/**
 * **改写已有文件**（编辑保存：`host.file.write.begin` 带 `overwrite: true`）。
 *
 * 为何与 `file.upload` 分开：两者改动的对象不同。上传最坏只是让用户的项目里**多出一个文件**
 * （同名时甚至会自动改成「 - 副本」）；而这里是**把已有文件的内容换掉** —— 那个文件可能是源码，
 * 也可能 AI 正在写它。于是「只让手机传照片、不让手机改代码」是一种该被支持的授权。
 *
 * ⚠️ 它同时是**功能标记**：旧电脑端不认识 `overwrite` 字段（会静默忽略它），一次覆盖保存就会
 * 退化成「另存为 - 副本」—— 用户以为改了、其实原文件一动没动。所以手机端**只在电脑端声明了
 * 这个能力名时才显示「编辑」入口**：缺了它就没有「静默做错一件事」的路径。
 */
export const FILE_EDIT_CAPABILITY = 'file.edit'

// ───────────────────────────── 限额（两端同一个数） ─────────────────────────────

/**
 * 单次 `host.file.read` / `host.file.write.chunk` 的**原始字节**上限。
 *
 * 为什么是 256KB：base64 后约 350KB 文本，一次 RPC 的 JSON 载荷约 350KB —— 帧层会分成
 * ~30 个 12KB 分片，两端都能平静地处理；再大（如 1MB）单帧组装的峰值内存与手机的
 * `JSON.parse` 都开始难受，而且**一点网络抖动就要重传整块**。
 */
export const FILE_CHUNK_BYTES = 256 * 1024

/**
 * 单文件**上传**上限（32MB）。
 *
 * 不是技术天花板（分块本身没有硬上限），而是产品口径：手机上的照片/文档几乎都在这个量级内，
 * 再大的文件用手机传是在浪费两边的电和流量 —— 且中继链路下我们本来就拒绝该功能。
 * 超限在 `write.begin` 就拒（而不是传到一半才说），手机端因此能在**开始前**就告诉用户。
 */
export const FILE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024

/**
 * 文本 / Markdown / 代码预览上限（1MB）。
 *
 * 超过它的「文本」在手机上没有阅读价值（几万行代码刷在 6 寸屏上），却要花掉整条链路的
 * 时间与流量。超限不是错误：文件照旧可以**下载**，只是不给行内预览。
 */
export const FILE_TEXT_PREVIEW_MAX_BYTES = 1024 * 1024

/**
 * 文本 / Markdown / 代码**编辑**上限（256KB）。
 *
 * 比预览上限（1MB）小，是手机侧的务实取舍：预览只需「渲染出来看」，而编辑要把全文塞进一个
 * `<textarea>`，保存时还要按分块回传 —— 1MB 的文本在手机上敲一个字都开始卡，一次保存也是
 * 4 次往返。超限不是错误：文件照旧能预览 / 下载，只是不给编辑入口（「请在电脑上改」）。
 */
export const FILE_EDIT_MAX_BYTES = 256 * 1024

/**
 * 图片预览上限（8MB）。
 *
 * 手机上直接渲染整张图，超限的图在移动端内存里放大/解码会直接崩掉标签页（且一眼看不出全貌）。
 */
export const FILE_IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

/**
 * 一次目录列举返回的条目上限。
 *
 * 目录里有几万项时，手机上的列表（与这条 RPC）都没意义；到顶就截断并让手机端如实提示
 * （`FileListResult.truncated`），而不是静默只给一部分。
 */
export const FILE_LIST_MAX_ENTRIES = 500

/**
 * 上传文件名的长度上限（字符）。
 *
 * 取 200 而不是 255：留出电脑侧冲突消解后缀（` - 副本 (99)`）的余量，避免「改名后反而超长」。
 */
export const FILE_NAME_MAX_LEN = 200

/**
 * 上传临时文件的后缀。
 *
 * 落盘纪律：**先写临时文件，`finish` 才改名到目标**（见 `host.file.write.*`）。
 * 于是「传输中断 / 用户取消」不会在用户的项目里留下一个**半截的真文件** ——
 * 用户看到的只会是一个明显是临时产物的名字，而不是一个「打开是坏的文件」。
 */
export const UPLOAD_PART_SUFFIX = '.virlen-part'

/**
 * 「只能直连」时给用户的那句话（**两端同一句**）。
 *
 * 为什么写进共享包：电脑端拒绝时要报它、手机端置灰入口时也要显示它。各写一句的后果是
 * 「手机上写着因为中继、电脑日志里写着别的原因」——而用户只会以为其中一个是 bug。
 */
export const FILE_DIRECT_ONLY_MESSAGE =
  '文件传输需要直连链路（当前经 TURN 中继服务器转发）：请让手机与电脑处于同一 WiFi 后重试'

/**
 * 链路通讯类型 → 「能不能传文件」（**两端唯一口径**）。
 *
 * 口径（用户 2026-10 拍板）：**只在确认走了 TURN 中继时拒绝**。
 *
 * - `relay` → 拒：每个字节都要过服务器绕一圈（手机流量 + 服务器带宽），而文件动辄几 MB
 *   —— 这正是 `TransferTier` 当初把消息正文砍成 `lean` 的同一笔账，只是量级差三个数量级；
 * - `direct` → 放行；
 * - `unknown` → **也放行**。这里与 `transferTierOf` 的取向**有意不同**：那边「拿不准就少发」
 *   的代价只是内容少一段（且有 `detail:'omitted'` 如实告知），这边「拿不准就不给用」的代价是
 *   **功能直接消失** —— 而 `unknown` 是常态（同源 Broadcast 联调、非 WebRTC 链路、
 *   刚打通还没定形的头几秒）。把常态判成禁用，用户看到的是「坏掉」，不是「保守」。
 *
 * ⚠️ 所以本函数**不是**权限：真正的授权是 ACL 的三个能力位。它只回答「这条链路值不值得传大文件」。
 * 消费方：电脑端在 `host.file.*` 入口调（拒绝时如实报 `E_DENIED`），手机端据此置灰入口。
 */
export function fileTransferDeniedReason(linkKind: string | null | undefined): string | null {
  return linkKind === 'relay' ? FILE_DIRECT_ONLY_MESSAGE : null
}

// ───────────────────────────── 预览分类 ─────────────────────────────

/** 手机端能行内渲染的类别；`binary` = 只能下载。 */
export type FilePreviewKind = 'text' | 'markdown' | 'image' | 'binary'

const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg',
])

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])

/**
 * 文本类扩展名（代码 / 配置 / 数据 / 文档）。
 *
 * 刻意**不收** `.pdf` / `.docx` / `.zip` 等二进制容器：它们在手机上要专门的渲染器，
 * 而「下载到手机再用别处打开」本来就是更好的路径。
 */
const TEXT_EXTS = new Set([
  // 代码
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'lua', 'dart', 'scala', 'clj',
  'r', 'pl', 'ex', 'exs', 'erl', 'hs', 'ml', 'nim', 'zig', 'asm', 's',
  // 标记 / 样式 / 数据
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'xml', 'svg',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'csv', 'tsv', 'txt', 'log', 'diff', 'patch', 'graphql', 'gql', 'proto', 'http',
  // 文档 / 脚手架
  'tex', 'rst', 'adoc', 'org',
])

/** 没有扩展名但**必然是文本**的常见文件名（大小写不敏感，前导点忽略）。 */
const TEXT_FILENAMES = new Set([
  'makefile', 'dockerfile', 'jenkinsfile', 'vagrantfile', 'procfile', 'brewfile',
  'license', 'licence', 'readme', 'changelog', 'notice', 'authors', 'contributing',
  'gitignore', 'gitattributes', 'gitmodules', 'npmrc', 'nvmrc', 'editorconfig',
  'env', 'envrc', 'babelrc', 'eslintrc', 'prettierrc', 'stylelintrc', 'browserslistrc',
  'lock', 'cmakelists.txt', 'go.mod', 'go.sum',
])

/** 拆扩展名（`a.tar.gz` 只认最后一段；与 `file-transfer-service` 同名函数同口径）。 */
export function splitNameExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  // 前导点（`.gitignore`）不算扩展名 —— 那整个名字就是「文件名」
  if (dot <= 0) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot + 1) }
}

/**
 * 文件名 → 预览类别（**两端唯一口径**）。
 *
 * 判不出来（未知扩展名 / 无扩展名且不在白名单）一律按 `binary` —— 保守侧是「只给下载」：
 * 把二进制按文本渲染会得到一屏乱码，比「请下载」难受得多。
 */
export function previewKindOf(name: string): FilePreviewKind {
  const trimmed = (name || '').trim()
  if (!trimmed) return 'binary'
  const { base, ext } = splitNameExt(trimmed)
  if (IMAGE_EXTS.has(ext.toLowerCase())) return 'image'
  if (MARKDOWN_EXTS.has(ext.toLowerCase())) return 'markdown'
  if (TEXT_EXTS.has(ext.toLowerCase())) return 'text'
  // 无扩展名时看整个名字（`Makefile` / `.gitignore`）——**只有**这一种情形才允许按名字判
  if (!ext) {
    const bare = trimmed.replace(/^\.+/, '').toLowerCase()
    if (TEXT_FILENAMES.has(trimmed.toLowerCase()) || TEXT_FILENAMES.has(bare)) return 'text'
    if (TEXT_FILENAMES.has(base.toLowerCase())) return 'text'
  }
  return 'binary'
}

/** 该类别的行内预览字节上限（`binary` = 0，即不预览）。 */
export function previewLimitOf(kind: FilePreviewKind): number {
  if (kind === 'image') return FILE_IMAGE_PREVIEW_MAX_BYTES
  if (kind === 'text' || kind === 'markdown') return FILE_TEXT_PREVIEW_MAX_BYTES
  return 0
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/x-scss',
  less: 'text/x-less',
  json: 'application/json',
  jsonc: 'application/json',
  json5: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/x-toml',
  xml: 'text/xml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  txt: 'text/plain',
  log: 'text/plain',
}

/**
 * MIME（给手机端决定 `<img src>` / Blob 类型用）。
 *
 * 判不出就给 `application/octet-stream` —— 浏览器遇到未知类型会**下载**而不是渲染，
 * 这正是「binary 只给下载」想要的行为。
 */
export function mimeTypeOf(name: string): string {
  const { ext } = splitNameExt((name || '').trim())
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream'
}

// ───────────────────────────── base64（零依赖纯函数） ─────────────────────────────

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const B64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i
  return table
})()

/**
 * 字节 → 标准 base64（带 `=` 补齐，无换行）。
 *
 * 为什么不用 `btoa`：它只吃 latin1 字符串，喂 `Uint8Array` 前得先拼一个 `String.fromCharCode`
 * 的巨型字符串（几 MB 的 `apply` 参数会直接爆栈）；而 `btoa` 在 Node 与浏览器里的可用性
 * 也不一致（本包要在 Node 侧跑测试）。这里自己实现，两端同一条码路。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const n = bytes.length
  const parts: string[] = []
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    parts.push(
      B64_ALPHABET[(v >> 18) & 63] +
        B64_ALPHABET[(v >> 12) & 63] +
        B64_ALPHABET[(v >> 6) & 63] +
        B64_ALPHABET[v & 63],
    )
  }
  const rest = n - i
  if (rest === 1) {
    const v = bytes[i] << 16
    parts.push(B64_ALPHABET[(v >> 18) & 63] + B64_ALPHABET[(v >> 12) & 63] + '==')
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8)
    parts.push(
      B64_ALPHABET[(v >> 18) & 63] +
        B64_ALPHABET[(v >> 12) & 63] +
        B64_ALPHABET[(v >> 6) & 63] +
        '=',
    )
  }
  return parts.join('')
}

/**
 * base64 → 字节。
 *
 * 宽容 **`=` 补位缺失**（部分实现会省略），但不宽容非法字符 —— 静默把坏字符当 0 会让
 * 「文件损坏」变成一个查不出来的谜。长度不对时抛错，由调用方包成协议错误。
 */
export function base64ToBytes(text: string): Uint8Array {
  const clean = text.trim()
  if (clean.length === 0) return new Uint8Array(0)
  let pad = 0
  let end = clean.length
  while (end > 0 && clean.charCodeAt(end - 1) === 61 /* '=' */) {
    pad++
    end--
    if (pad > 2) throw new Error('base64: too much padding')
  }
  const dataLen = end
  const size = Math.floor((dataLen * 3) / 4)
  const rest = dataLen % 4
  if (rest === 1) throw new Error('base64: invalid length')
  const out = new Uint8Array(size)
  let outIndex = 0
  let acc = 0
  let accBits = 0
  for (let i = 0; i < dataLen; i++) {
    const code = clean.charCodeAt(i)
    const value = code < 128 ? B64_LOOKUP[code] : -1
    if (value < 0) throw new Error(`base64: invalid character at ${i}`)
    acc = (acc << 6) | value
    accBits += 6
    if (accBits >= 8) {
      accBits -= 8
      out[outIndex++] = (acc >> accBits) & 0xff
    }
  }
  return outIndex === size ? out : out.subarray(0, outIndex)
}

// ───────────────────────────── 展示辅助（两端同一个数） ─────────────────────────────

/**
 * 字节数 → 人话（`1.2 MB`）。
 *
 * 与电脑侧 `infrastructure/tools/file/common.ts::formatSize` **同一套进位**（1024 进制、
 * 非 B 保留一位小数）；那条是**给模型看的工具输出**，不能改，故这里是它的人话版兄弟。
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

// ───────────────────────────── 文本编辑（字节的往返） ─────────────────────────────

/**
 * 换行风格。
 *
 * 为何必须记住它：**手机上的 `<textarea>` 只有 LF**（HTML 规范要求换行进出一律规范化成 LF），
 * 而 Windows 上的源码 / `.bat` / `.ps1` 大多是 CRLF。照 LF 存回去，等于在「只改了三个字符」的
 * 改动里混进一次**全文行尾改写** —— diff 满屏红，评审时根本看不出到底改了什么。
 */
export type EolStyle = 'lf' | 'crlf'

/** 这个类别能不能编辑（纯文本 / 代码 / Markdown 源码）；图片与二进制一律不能。 */
export function isEditableKind(kind: FilePreviewKind): boolean {
  return kind === 'text' || kind === 'markdown'
}

/** 这个名字能不能编辑（= 它的预览类别可编辑 —— 与预览共用同一张扩展名表，不另开一份）。 */
export function isEditableFileName(name: string): boolean {
  return isEditableKind(previewKindOf(name))
}

/**
 * 原文的换行风格：**按多数**判（`\r\n` 多于单跑的 `\n` 才算 CRLF）。
 *
 * 跨平台协作下混用并不罕见，按多数至少不会把整篇都翻过去；一个换行都没有时给 `lf`。
 */
export function detectEolStyle(text: string): EolStyle {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10 /* \n */) continue
    if (i > 0 && text.charCodeAt(i - 1) === 13 /* \r */) crlf++
    else lf++
  }
  return crlf > lf ? 'crlf' : 'lf'
}

/**
 * 按指定风格铺开换行。
 *
 * ⚠️ 先把所有换行形式**拉平再铺**，不能只做 `\n → \r\n`：原文里本来就有的 CRLF 会变成
 * `\r\r\n`，那个多出来的 `\r` 在编辑器里就是一个空行 —— 「保存一次多出一堆空行」的经典 bug。
 */
export function applyEolStyle(text: string, style: EolStyle): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  return style === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized
}

/** 是否带 UTF-8 BOM（保存时原样保留：它是某些 Windows 工具识别编码的唯一依据）。 */
export function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

/**
 * **严格** UTF-8 解码：不是合法 UTF-8（GBK 中文注释、二进制混入…）→ `null`。
 *
 * 为何不能宽容解码后再编辑：宽容解出来的乱码一旦被编辑保存回去，就是**把用户的文件毁掉**
 * （原来「在电脑上还能正常看」，存完连电脑上也读不回来了）。所以拿到 `null` 就不给编辑入口，
 * 只给「请在电脑上改」。
 *
 * BOM 在这里被剥掉（编辑区里不该有一个看不见的字符），保存时由 `encodeEditedText` 补回。
 */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return null
  }
}

/**
 * 编辑结果 → 落盘字节（**唯一**的编码出口：换行还原与 BOM 还原都在这里）。
 *
 * 于是两端不需要各写一份口径：手机端把「最终字节」传上去，电脑侧只管覆写。
 */
export function encodeEditedText(text: string, options: { eol: EolStyle; bom: boolean }): Uint8Array {
  const body = new TextEncoder().encode(applyEolStyle(text, options.eol))
  if (!options.bom) return body
  const out = new Uint8Array(body.length + 3)
  out.set([0xef, 0xbb, 0xbf], 0)
  out.set(body, 3)
  return out
}

// ───────────────────────────── 相对路径工具 ─────────────────────────────

/**
 * 规整手机传来的**相对工作目录**路径。
 *
 * 规则（与电脑侧 `resolveSafePath` 的「相对路径拼接」互补，不是重复校验）：
 * - `\\` → `/`；去掉前导 `/`（手机永远说相对路径，绝对路径一律不许）；
 * - 去掉 `.` 段与空段；`..` **就地抵消**上一段，抵消不掉的（逃到工作目录之上）**直接丢掉**；
 * - 结果为空串 = 工作目录根。
 *
 * ⚠️ 这**不是**安全边界（安全边界在电脑侧）：它只保证「手机说的路径」形状可控，
 * 于是越权尝试会退化成一个**明确不存在的路径**（E_NOT_FOUND），而不是一个含糊的路径穿越事故。
 */
export function normalizeRelPath(input: string): string {
  const raw = (input ?? '').replace(/\\/g, '/')
  const out: string[] = []
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.join('/')
}

/** 拼一个相对路径（空目录段 = 根）。 */
export function joinRelPath(dir: string, name: string): string {
  return normalizeRelPath(`${dir ?? ''}/${name ?? ''}`)
}

/** 取父目录（根目录的父目录仍是根目录）。 */
export function parentOfRelPath(path: string): string {
  const normalized = normalizeRelPath(path)
  const idx = normalized.lastIndexOf('/')
  return idx < 0 ? '' : normalized.slice(0, idx)
}

/** 取末段名（根目录 → `''`）。 */
export function baseNameOfPath(path: string): string {
  const normalized = normalizeRelPath(path)
  const idx = normalized.lastIndexOf('/')
  return idx < 0 ? normalized : normalized.slice(idx + 1)
}

/**
 * 条目名是否可用（手机**上传**时它先自检一遍，电脑侧再独立校验一次）。
 *
 * 拒绝：空名、`.` / `..`、含路径分隔符、含 Windows 保留字符、超长。理由不是洁癖 ——
 * 这些名字到了磁盘上会变成别的东西（`..` 直接是目录穿越，`a/b` 会被当子目录创建）。
 */
export function isSafeEntryName(name: string): boolean {
  const raw = name ?? ''
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > FILE_NAME_MAX_LEN) return false
  // 首尾空白直接拒（而不是静默 trim）：落盘的应当是用户看到的那串字符
  if (raw !== trimmed) return false
  if (trimmed === '.' || trimmed === '..') return false
  if (/[/\\]/.test(trimmed)) return false
  // Windows 保留字符 + 结尾的点/空格（在 Windows 上会被静默吞掉，造成「名字对不上」）
  if (/[<>:"|?*\u0000-\u001f]/.test(trimmed)) return false
  if (/[. ]$/.test(trimmed)) return false
  return true
}

/**
 * 同名冲突时的候选名：`a.txt` → `a - 副本.txt` → `a - 副本 (2).txt`。
 *
 * 与电脑侧 `file-transfer-service` 的 `DUPLICATE_SUFFIX` **同一条口径**（资源管理器的说法）：
 * 用户在这个项目的桌面端看到过「 - 副本」，手机上再看到一次不会觉得是两种行为。
 */
export function duplicateNameCandidate(name: string, index: number): string {
  const { base, ext } = splitNameExt(name)
  const suffix = index <= 1 ? ' - 副本' : ` - 副本 (${index})`
  return `${base}${suffix}${ext ? `.${ext}` : ''}`
}

/** 目录列举的稳定排序：**目录在前**，同层按名称（忽略大小写的字典序）。两端同一口径。 */
export function compareFileEntries(
  a: { name: string; isDir: boolean },
  b: { name: string; isDir: boolean },
): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}
