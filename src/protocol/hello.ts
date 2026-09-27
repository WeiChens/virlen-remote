/**
 * 版本与能力协商（见 docs/phone-control-bridge.md §3.5）。
 *
 * 规则：
 * - 双方各自报能力集，**取交集**驱动 UI 显隐；
 * - 主版本不匹配 → 拒绝并提示升级（**不要试图兼容**）；
 * - 新方法只增不改；破坏性变更才升 major。
 *
 * 兼容性靠 **`E_UNSUPPORTED` 错误**而不是版本号 if-else —— 老端调新方法时明确报错，UI 隐藏该功能。
 */
import { BridgeError } from './errors'
import type { GrantRecord } from './identity'

export interface ClientInfo {
  platform: string
  appVersion: string
}

/** 发起方（手机）hello 参数。 */
export interface HelloParams {
  protocolVersion: number
  client: ClientInfo
  capabilities: string[]
  /**
   * 配对令牌。
   *
   * - **首次配对**：二维码里的**一次性票据**（兑换后电脑端签发 `grant` 回传，见 §30.3）；
   * - **已配对设备**：本地存储的**授权凭证**（`grant`，电脑端滑动续期）。
   */
  token?: string
  /**
   * 手机设备 key（`mk-…`，M6 新增，**可选**）。
   *
   * 为什么可选：已装机的旧版 PWA 不会带它。电脑端把它当作「临时设备」放行（凭证仍要有效），
   * 等手机端更新后再回填绑定（§30.5 的渐进迁移）。
   */
  mobileKey?: string
  /** 手机显示名（电脑端列表里显示；缺省由电脑端给「Virlen 手机」）。 */
  mobileName?: string
}

/** 应答方（电脑）hello 结果。 */
export interface HelloResult {
  protocolVersion: number
  host: ClientInfo
  capabilities: string[]
  paired: boolean
  deviceName: string
  /** 电脑设备 key，手机据以保存设备记录（同时也是房间号的来源）。 */
  deviceId?: string
  /**
   * 当前有效的授权凭证（**含首次配对新签发的那条**）。
   *
   * 手机端必须用它覆盖本地记录：首次配对时手机手上只有一次性票据，真正的长期凭证在这里；
   * 已配对设备每次连接也会拿到（滑动续期后的到期时间）。
   */
  grant?: GrantRecord
}

export interface NegotiationInput {
  protocolVersion: number
  capabilities: readonly string[]
}

export interface Negotiated {
  protocolVersion: number
  /** 双方能力的交集（有序、去重，保持 local 顺序）。 */
  capabilities: string[]
}

/** 取交集：结果保持 `local` 的顺序、去重。 */
export function intersectCapabilities(local: readonly string[], remote: readonly string[]): string[] {
  const remoteSet = new Set(remote)
  const seen = new Set<string>()
  const result: string[] = []
  for (const cap of local) {
    if (remoteSet.has(cap) && !seen.has(cap)) {
      seen.add(cap)
      result.push(cap)
    }
  }
  return result
}

/**
 * 协商。主版本不匹配抛 `E_UNSUPPORTED`（不可重试）——调用方应提示「请升级客户端」。
 */
export function negotiate(local: NegotiationInput, remote: NegotiationInput): Negotiated {
  if (local.protocolVersion !== remote.protocolVersion) {
    throw new BridgeError(
      'E_UNSUPPORTED',
      `protocol version mismatch: local=${local.protocolVersion}, remote=${remote.protocolVersion}`,
    )
  }
  return {
    protocolVersion: local.protocolVersion,
    capabilities: intersectCapabilities(local.capabilities, remote.capabilities),
  }
}
