/**
 * 消息里的**文件引用** —— **两端共用的契约**：能力名 + 引用体 + 校验口径。
 *
 * ## 这是什么（与桌面输入框的「文件附件」同一条口径）
 *
 * 手机端在文件面板里挑一个电脑上的文件，把它的**路径 + 展示元数据**挂到要发的那条消息上；
 * 电脑端把它组装成 `{type:'file'}` 内容块交给引擎。**不搬运文件内容** ——
 * 真正的读取交给 AI 用 `read_file` 工具按需完成（桌面端 `FileAttachment` 的文件头
 * 写着同一条：「只存路径，不拷贝文件内容」）。
 *
 * ## 为什么必须放在共享包里
 *
 * 与 §36 的引用（`message-actions.ts`）同一条理由：它是**两端各表一半**的约定 ——
 * 手机端发 `SendParams.files` 并把 `MessageDTO.files` 渲染成 chip，电脑端把前者组装成内容块、
 * 把后者投影出来。字段名（`path` / `isDir` / `size`）与「路径分隔符统一成 `/`」的归一化
 * 各写一份必然漂移，而漂移的症状是**静默的**：元数据对不上时 chip 显示成另一个东西，
 * 没有任何报错可查。
 *
 * ## 校验为什么也在这里（而不是电脑侧自己写一份）
 *
 * `sanitizeFileRefs` 是**两端唯一的校验口径**：真电脑侧（`virlen-app/src/bridge/host-source.ts`）
 * 与演示宿主（`testing/mock-host.ts`）都调它。若各写一份，mock 与真机会在「什么样的 `files`
 * 算非法」上分叉 —— 而 mock 是单测的唯一参照物，分叉等于测试对着假行为发绿灯。
 *
 * ## 能力位的语义（与 §36 的 `MESSAGE_QUOTE_CAPABILITY` 一致）
 *
 * `MESSAGE_FILE_CAPABILITY` 是**功能标记**，不是权限：文件引用本身就是 `session.send` 的一个
 * 参数（越权防线仍是 ACL 里的 `session.send`）。写进本表只为让手机端知道
 * 「本机电脑端认识 `files`」—— 旧电脑端会把未知字段**静默丢掉**，用户侧的表现是
 * 「我明明附了文件，AI 却当没看见」，且没有任何报错可查。宁可对旧电脑端不显示这个入口。
 */
import { FILE_NAME_MAX_LEN } from './files'

/**
 * 手机端声明它 = **文件面板能给「引用」入口**，并能渲染 `MessageDTO.files` 的 chip。
 * 电脑端列出它 = **本机认识 `SendParams.files` 与 `MessageDTO.files`**。
 */
export const MESSAGE_FILE_CAPABILITY = 'message.file'

/**
 * 一条消息最多能带几个文件引用。
 *
 * 上限的意义有两层：① 超过之后模型也只是「看得到一堆路径」，边际收益为零；
 * ② 它是**载荷上界**（每个引用都在消息里，且会随消息一起持久化 / 导出 / 重放）。
 * 超限**拒整条**而不是截断：截断是静默的 —— 手机端的 chip 还在，用户会以为都带上了。
 */
export const MESSAGE_FILE_MAX = 20

/**
 * 单个引用路径的长度上限（1024 字符）。
 *
 * 与 `MESSAGE_FILE_MAX` 同一条纪律：路径是**手机端给的字符串**，没有上界就等于允许
 * 一个（有 bug 或被改写的）客户端把任意长的内容塞进消息里。正常路径远低于这个数
 * （Windows 的 `MAX_PATH` 是 260）。
 */
export const MESSAGE_FILE_PATH_MAX = 1024

/**
 * 一条**文件引用**（手机端 → 电脑端 → 引擎内容块）。
 *
 * ⚠️ 与 `MessageQuote` 不同，这里**不是快照**：存的是路径，AI 读的那一刻磁盘上是什么就是什么。
 * 这正是「不搬运内容」的代价，也是它的好处（引用的永远是**当前**内容，不会拿一份过期副本
 * 去回答）。桌面端的文件附件同此语义。
 */
export interface MessageFileRef {
  /** 文件绝对路径（分隔符按契约统一为 `/`，见 `sanitizeFileRefs`）。 */
  path: string
  /** 文件名（含扩展名）—— chip 上显示的就是它。 */
  name: string
  /** 是否为目录（目录也能被引用：模型用 `list_files` 去看里面有什么）。 */
  isDir?: boolean
  /** 字节数（目录没有这一项）。只用于展示，**不作为任何校验依据**（它不是文件的事实来源）。 */
  size?: number
}

/**
 * 校验结果。
 *
 * ⚠️ **刻意不写成判别联合**（`| { ok: true; files } | { ok: false; reason }`）：
 * 布尔字面量的判别联合靠 `strictNullChecks` 才能收窄，而消费方 `virlen-app` 的 tsconfig 是
 * `strictNullChecks: false` —— 写成判别联合的话，电脑侧那句 `if (!r.ok) { …r.reason… }`
 * 根本收窄不了（直接 `TS2339: Property 'reason' does not exist`）。契约放在共享包里，
 * 就不能只在一边成立。
 *
 * 不变式：`ok === (reason === '')`（通过时 `reason` 是空串，`files` 是被归一化的引用；
 * 被拒时 `files` 恒为空数组）。
 */
export interface FileRefSanitizeResult {
  /** 是否通过校验。 */
  ok: boolean
  /** 归一化后的引用；被拒时恒为空数组（调用方那时应该直接抛错）。 */
  files: MessageFileRef[]
  /** 被拒原因（可直接显示给用户）；通过时为空串。 */
  reason: string
}

/**
 * 校验并归一化手机传来的文件引用（**电脑侧与演示宿主共用这一份**）。
 *
 * 规则：
 *  - 缺省 / `null` → 空数组（不带文件引用是完全正常的一条消息）；
 *  - 不是数组 / 条目不是对象 / `path` 不是非空字符串 → **整条拒**（返回 `ok:false`）；
 *  - 路径超过 `MESSAGE_FILE_PATH_MAX`、条目数超过 `MESSAGE_FILE_MAX` → 整条拒；
 *  - `name` 缺失或为空 → 用路径末段兜底（电脑侧从内容块投影回来时也会用到这条）；
 *  - `isDir` / `size` 形状不对 → **丢掉该字段**（它们是展示元数据，说谎也只是 chip 上少一行字），
 *    但路径非法必须拒 —— 那是这条引用**唯一有语义的部分**。
 *  - 路径分隔符 `\` → `/`（与全项目的路径口径一致，两侧拼串才不会出现 `a\/b`）；
 *  - 同一路径只保留第一次出现的（手机端连点两下不该变成两条引用）。
 *
 * ## 为什么非法就整条拒（而不是「丢掉那一条、其余照发」）
 *
 * §36 的教训：**假绿灯比报错难查得多**。丢掉一条引用时，手机端那边的 chip 还在输入框里、
 * 发完消息里也有它 —— 用户会以为带上了，而 AI 从未看到。拒掉整条之后，用户看到的是
 * 一条明确的失败提示，芯片还在，可以改完再发。
 */
export function sanitizeFileRefs(input: unknown): FileRefSanitizeResult {
  /** 被拒（`files` 恒为空数组 —— 失败就是**整条**失败，没有「部分成功」这个态） */
  const reject = (reason: string): FileRefSanitizeResult => ({ ok: false, files: [], reason })

  if (input == null) return { ok: true, files: [], reason: '' }
  if (!Array.isArray(input)) return reject('文件引用的形状不对')
  if (input.length > MESSAGE_FILE_MAX) {
    return reject(`一次最多引用 ${MESSAGE_FILE_MAX} 个文件`)
  }

  const files: MessageFileRef[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) {
      return reject('文件引用的形状不对')
    }
    const item = raw as Partial<MessageFileRef>
    if (typeof item.path !== 'string' || !item.path.trim()) {
      return reject('文件引用缺少路径')
    }
    // 归一化分隔符：`E:\a\b` → `E:/a/b`（与 `normalizeWorkspace` / 文件面板同一口径）
    const path = item.path.replace(/\\/g, '/')
    if (path.length > MESSAGE_FILE_PATH_MAX) {
      return reject('文件路径过长')
    }
    if (seen.has(path)) continue
    seen.add(path)

    const name = typeof item.name === 'string' ? item.name.trim() : ''
    files.push({
      path,
      name: (name || baseName(path)).slice(0, FILE_NAME_MAX_LEN),
      ...(typeof item.isDir === 'boolean' ? { isDir: item.isDir } : {}),
      ...(typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0
        ? { size: item.size }
        : {}),
    })
  }
  return { ok: true, files, reason: '' }
}

/** 路径末段（`name` 缺失时的兜底；本地实现以免把 `protocol/files` 的整套路径工具拖进来）。 */
function baseName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}
