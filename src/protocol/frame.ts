/**
 * 帧编解码（见 docs/phone-control-bridge.md §3.1/§3.2）。
 *
 * 12 字节二进制头 + UTF-8 JSON 载荷。**现在就上二进制头**的理由：
 * 分片是必然会需要的（长消息、大列表），而分片必须靠「帧头 + 归组 id」；
 * 若一期先发裸 JSON，等需要分片时要改所有帧格式 → 返工。一期 `chunkCount` 恒为 1 即可，零额外成本。
 *
 * ```
 * 偏移  字段         类型     说明
 *  0    version      u8       协议主版本（当前 =1）
 *  1    kind         u8       1=CALL 2=RESULT 3=EVENT 4=CTRL
 *  2    chunkIndex   u16 LE   分片序号，从 0 开始
 *  4    chunkCount   u16 LE   本次逻辑消息的分片总数（无分片 =1）
 *  6    flags        u16 LE   保留（bit0 预留=压缩）
 *  8    msgId        u32 LE   发送方单调递增，**仅用于分片归组**（回指靠载荷里的 requestId）
 * 12..  payload      UTF-8 JSON
 * ```
 */
import { BridgeError } from './errors'

export const PROTOCOL_VERSION = 1
export const HEADER_SIZE = 12
/** 超过该阈值的载荷即分片（见 §3.2）。 */
export const DEFAULT_MAX_FRAME_PAYLOAD = 12 * 1024

export const FrameKind = {
  CALL: 1,
  RESULT: 2,
  EVENT: 3,
  CTRL: 4,
} as const
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind]

const MAX_CHUNK_COUNT = 0xffff

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface FrameHeader {
  version: number
  kind: FrameKind
  chunkIndex: number
  chunkCount: number
  flags: number
  msgId: number
}

/** 一个已完整还原的逻辑消息。 */
export interface DecodedMessage<T = unknown> {
  header: FrameHeader
  payload: T
}

export function encodeHeader(header: FrameHeader): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, header.version)
  dv.setUint8(1, header.kind)
  dv.setUint16(2, header.chunkIndex, true)
  dv.setUint16(4, header.chunkCount, true)
  dv.setUint16(6, header.flags, true)
  dv.setUint32(8, header.msgId, true)
  return buf
}

export function decodeHeader(bytes: Uint8Array, offset = 0): FrameHeader {
  if (bytes.length - offset < HEADER_SIZE) {
    throw new BridgeError('E_BAD_REQUEST', `frame too short: ${bytes.length - offset} < ${HEADER_SIZE}`)
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, HEADER_SIZE)
  return {
    version: dv.getUint8(0),
    kind: dv.getUint8(1) as FrameKind,
    chunkIndex: dv.getUint16(2, true),
    chunkCount: dv.getUint16(4, true),
    flags: dv.getUint16(6, true),
    msgId: dv.getUint32(8, true),
  }
}

/** 读取帧体（不含头）。 */
export function frameBody(frame: Uint8Array): Uint8Array {
  return frame.subarray(HEADER_SIZE)
}

/**
 * 把一条逻辑消息编码为 1..N 个帧。载荷 > `maxFramePayload` 时自动分片。
 * 返回的数组顺序即分片顺序（chunkIndex 0..n-1）。
 */
export function encodeFrames(
  kind: FrameKind,
  msgId: number,
  payload: unknown,
  maxFramePayload: number = DEFAULT_MAX_FRAME_PAYLOAD,
): Uint8Array[] {
  const json = textEncoder.encode(payload === undefined ? '' : JSON.stringify(payload))
  const chunkCount = Math.max(1, Math.ceil(json.length / maxFramePayload))
  if (chunkCount > MAX_CHUNK_COUNT) {
    throw new BridgeError('E_BAD_REQUEST', `payload too large: needs ${chunkCount} chunks (> ${MAX_CHUNK_COUNT})`)
  }
  const frames: Uint8Array[] = []
  for (let index = 0; index < chunkCount; index++) {
    const start = index * maxFramePayload
    const slice = json.subarray(start, start + maxFramePayload)
    const frame = new Uint8Array(HEADER_SIZE + slice.length)
    frame.set(encodeHeader({ version: PROTOCOL_VERSION, kind, chunkIndex: index, chunkCount, flags: 0, msgId }), 0)
    frame.set(slice, HEADER_SIZE)
    frames.push(frame)
  }
  return frames
}

interface PartialMessage {
  header: FrameHeader
  chunks: Array<Uint8Array | undefined>
  received: number
}

/**
 * 分片归组器 —— 按 `msgId` 收集分片，**完整才交付**（不完整则整体丢弃，不做部分应用）。
 *
 * 天然容忍：分片乱序、多条消息交错（不同 msgId 各自独立累积）。
 */
export class Reassembler {
  private readonly partials = new Map<number, PartialMessage>()

  constructor(private readonly maxPartials = 64) {}

  /** 喂入一帧；返回已完整还原的消息，否则 null。 */
  accept(frame: Uint8Array): DecodedMessage | null {
    const header = decodeHeader(frame)
    const body = frameBody(frame)

    if (header.chunkCount <= 1) {
      return { header, payload: this.decodePayload(body) }
    }

    let partial = this.partials.get(header.msgId)
    if (!partial) {
      if (this.partials.size >= this.maxPartials) {
        this.evictOldest()
      }
      partial = { header, chunks: new Array<Uint8Array | undefined>(header.chunkCount), received: 0 }
      this.partials.set(header.msgId, partial)
    }

    if (header.chunkIndex >= partial.chunks.length) {
      this.partials.delete(header.msgId)
      throw new BridgeError('E_BAD_REQUEST', `chunkIndex ${header.chunkIndex} out of range (${partial.chunks.length})`)
    }

    if (partial.chunks[header.chunkIndex] === undefined) {
      partial.chunks[header.chunkIndex] = body
      partial.received++
    }

    if (partial.received === partial.chunks.length) {
      this.partials.delete(header.msgId)
      return { header: partial.header, payload: this.decodePayload(concatChunks(partial.chunks)) }
    }
    return null
  }

  /** 正在等待后续分片的逻辑消息数（诊断用）。 */
  get pendingCount(): number {
    return this.partials.size
  }

  reset(): void {
    this.partials.clear()
  }

  private decodePayload(body: Uint8Array): unknown {
    if (body.length === 0) return undefined
    return JSON.parse(textDecoder.decode(body))
  }

  private evictOldest(): void {
    const oldest = this.partials.keys().next().value
    if (oldest !== undefined) this.partials.delete(oldest)
  }
}

function concatChunks(chunks: Array<Uint8Array | undefined>): Uint8Array {
  let total = 0
  for (const c of chunks) total += c?.length ?? 0
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    if (c) {
      merged.set(c, offset)
      offset += c.length
    }
  }
  return merged
}
