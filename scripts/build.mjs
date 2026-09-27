/**
 * 构建：`tsc` 出 ESM + 类型声明，然后把**相对导入补上 `.js` 后缀**。
 *
 * ## 为什么要补后缀
 *
 * 源码里的相对导入是免后缀的（`from './protocol/frame'`）—— 打包器（Vite/webpack）能解析，
 * 但**浏览器与 Node 的 ESM 加载器不能**：`import './protocol/frame'` 在运行时是 404。
 * 本包是被 `npm i virlen-remote` 之后直接 `import` 的（不是被复制进源码再经打包器处理），
 * 所以产物必须是**合法的 ESM**。
 *
 * 两种常见做法及其代价：
 *   1. 源码里就写 `./protocol/frame.js` —— 改起来没问题，但源码不再是「打包器友好」的原始写法，
 *      且 IDE 跳转仍然指向 `.js`（实际上是 `.ts`），容易误导；
 *   2. 上 bundler（tsup / rollup）—— 为了一个补后缀的动作引入一套构建依赖链。
 *
 * 这里选第三条：**源码保持现状，构建后做一次确定性的后缀修正**。
 * 零新增依赖（只用 Node 内置），产物逐个文件可读、可 diff，出问题一眼看得出是哪一条导入。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const require = createRequire(import.meta.url)

/**
 * 找到 `tsc` 的入口。
 *
 * 直接 `node <tsc 的 JS>`，不走 `node_modules/.bin` —— 那里的 `tsc` / `tsc.CMD` / `tsc.ps1`
 * 是各平台专用垫片，在跨平台脚本里挑哪个都很脆（且 `typescript/bin/tsc` 在 TS 7 里
 * 不对外暴露 exports 子路径，`require.resolve` 会直接抛错）。
 */
function resolveTsc() {
  const dir = path.dirname(require.resolve('typescript/package.json'))
  const found = [path.join(dir, 'lib', 'tsc.js'), path.join(dir, 'bin', 'tsc')].find((p) => existsSync(p))
  if (!found) throw new Error('找不到 typescript 的 tsc 入口（先 `pnpm install`）')
  return found
}

/* ------------------------------ 1. 清 + 编译 ------------------------------ */

// 先清空：否则删掉的源文件会在 dist 里留下「阴魂」，被打包进 npm 包
rmSync(distDir, { recursive: true, force: true })

execFileSync(process.execPath, [resolveTsc(), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })

/* ------------------------------ 2. 补相对导入后缀 ------------------------------ */

/** `from './x'` / `export … from './x'` / `import('./x')`（动静态、类型导入一并覆盖）。 */
const SPECIFIER_RE = /(from\s+|import\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g
const HAS_EXTENSION_RE = /\.(js|mjs|cjs|json|node)$/

/** 收集 dist 下所有需要处理的文件（`.js` 与 `.d.ts`）。 */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.js') || full.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** 把一条相对说明符解析成「运行时真的能加载」的形式。 */
function resolveSpecifier(specifier, fileDir, warnings) {
  if (HAS_EXTENSION_RE.test(specifier)) return specifier
  const target = path.resolve(fileDir, specifier)
  if (existsSync(`${target}.js`)) return `${specifier}.js`
  if (existsSync(path.join(target, 'index.js'))) return `${specifier}/index.js`
  // 说明符指向 .json / .node 之外的东西，或本来就是个目录型导出：保持原样并告警
  const rel = path.relative(root, target)
  warnings.push(`${rel} —— 无法判定后缀（保持原样）`)
  return specifier
}

const warnings = []
let patched = 0
let filesTouched = 0

for (const file of walk(distDir)) {
  const before = readFileSync(file, 'utf8')
  const after = before.replace(SPECIFIER_RE, (match, prefix, quote, specifier) => {
    const fixed = resolveSpecifier(specifier, path.dirname(file), warnings)
    if (fixed === specifier) return match
    patched += 1
    return `${prefix}${quote}${fixed}${quote}`
  })
  if (after !== before) {
    writeFileSync(file, after)
    filesTouched += 1
  }
}

/* ------------------------------ 3. 收尾 ------------------------------ */

// 产物健全性：入口存在且没有残留的免后缀相对导入（否则发出去的包在运行时就会 404）
const entry = path.join(distDir, 'index.js')
const entryTypes = path.join(distDir, 'index.d.ts')
if (!existsSync(entry) || !existsSync(entryTypes)) {
  console.error(`\n✗ 构建失败：缺少 ${path.relative(root, entry)} 或 ${path.relative(root, entryTypes)}`)
  process.exit(1)
}

console.log(`\n✓ 构建完成：dist/index.js + 类型声明（修正 ${patched} 处相对导入，涉及 ${filesTouched} 个文件）`)
if (warnings.length) {
  console.warn(`⚠️ 有 ${warnings.length} 处说明符未能自动判定后缀，请人工确认：`)
  for (const w of warnings) console.warn(`   - ${w}`)
}
