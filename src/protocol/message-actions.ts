/**
 * 消息级操作（引用 / 删除）—— **两端共用的契约**：能力名 + 引用引用体。
 *
 * ## 为什么这两个东西要放在共享包里
 *
 * 与 §33 的传输档位同一条理由：它们都是**两端各表一半**的约定。
 *  - **引用**：手机端发 `SendParams.quotes`，电脑端把它组装成 `{type:'quote'}` 内容块；
 *    手机端还要把 `MessageDTO.quotes` 渲染成引用条。字段名、角色取值域、快照语义
 *    写两份必然漂移（一边 `quote`、一边 `quotes`，或一边 `assistant`、一边 `ai`）。
 *  - **删除**：手机端长按菜单里的「删除」项**只在电脑端声明能力时才出现** ——
 *    能力名是这里的常量，不是两边各写一遍的字面量（§33 的 `typeof` 绑定同一条教训）。
 *
 * ## 能力的两类语义（与 §33 的 `MESSAGE_DETAIL_CAPABILITY` 一致）
 *
 * 本包里导出的能力名有两种角色，**消费方必须分清**：
 *  - **功能标记**（`MESSAGE_QUOTE_CAPABILITY` 与 §33 的 `MESSAGE_DETAIL_CAPABILITY`）：
 *    只用来决定「界面给不给这个入口」，**不会被 ACL 的 `assert()` 拦**——引用本身就是
 *    `session.send` 的一个参数，不是新的权限；
 *  - **权限**（`MESSAGE_DELETE_CAPABILITY`）：删消息是**破坏性操作**，电脑端必须独立
 *    `assert` 它，缺失即 `E_DENIED`——手机端不显示按钮**不是**防线（§7-⑪ 的教训）。
 */

/**
 * 一条被引用消息的**快照引用**。
 *
 * ⚠️ `text` 是**快照**，不是外键：被引用的原消息可能随后被删除、被上下文压缩替换、
 * 或滚出手机端的已加载窗口（§20.2 分页）—— 只存 `messageId` 的话，发给模型的引用内容
 * 会在那些情形下凭空缺失，而用户界面上一无所知。这与桌面输入框的 `QuoteAttachment`
 * **同一条口径**（`ui/pages/chat/components/input/hooks.ts`）。
 *
 * 角色取值域只有 `user` / `assistant`：**只有「有正文的两方发言」可被引用**。
 * `tool`（工具输出）与 `system`（压缩摘要）不是对话发言，引用它们没有语义
 * （桌面端的右键菜单同样不给它们「引用」项）。
 */
export interface MessageQuote {
  /** 被引用消息的 id（同时用作 UI 列表 key / 去重键）。 */
  messageId: string
  /** 被引用消息的发送方。 */
  role: 'user' | 'assistant'
  /** 被引用消息的正文快照（原消息被删 / 被压缩后，引文仍然完整）。 */
  text: string
}

/**
 * 手机端声明它 = **长按气泡的菜单里提供「引用」**，并能把引用条渲染出来。
 * 电脑端列出它 = **本机认识 `SendParams.quotes` 与 `MessageDTO.quotes`**。
 *
 * 为什么必须有这道闸（不是可选的礼貌）：**已部署的旧电脑端不认 `quotes` 参数** ——
 * 它是普通字段，RPC 会正常成功，引文被静默丢掉。用户侧的表现是「我明明引用了，
 * AI 却当没看见」，且没有任何报错可查。宁可对旧电脑端不显示这个入口。
 */
export const MESSAGE_QUOTE_CAPABILITY = 'message.quote'

/**
 * 删除单条消息（及其后全部）的能力名 —— 电脑端 ACL 必须声明它，手机端才显示「删除」项。
 *
 * 与上面那个不同，**这是权限而不是功能标记**：电脑端在 handler 里独立 `assert`，
 * 未授权即 `E_DENIED`。手机端隐藏入口只是 UI 收敛，绝不构成防线（§7-⑪）。
 */
export const MESSAGE_DELETE_CAPABILITY = 'message.delete'
