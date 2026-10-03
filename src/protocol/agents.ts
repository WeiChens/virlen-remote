/**
 * Agent 相关的能力名（两端共用的唯一一份口径）。
 *
 * 为什么单列一个模块：`session.agent` 是**权限**而不是功能标记 ——
 * 新建会话时选定 Agent 决定这条会话的 systemPrompt / 工具白名单 / skills / 默认参数
 * （电脑侧落点是 `chat-service.createSession(…, agent, …)`），是实实在在的授权范围变化。
 * 所以电脑侧的 handler 必须独立 `assert`（手机端隐藏入口只是 UI 收敛，§7-⑪ 的教训）。
 *
 * 与 `message-actions.ts` 里的两个常量同族：常量写在共享包里、两端 import 同一个字面量，
 * 免得一边写成 `session.agents`、另一边写 `session.agent` 却没人发现（能力名不匹配时
 * 不会报错，只会「UI 不显示」这种最费解的症状）。
 */
export const SESSION_AGENT_CAPABILITY = 'session.agent'
