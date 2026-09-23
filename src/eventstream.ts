/**
 * Incremental decoder for the AWS event-stream binary framing Kiro streams responses in.
 *
 * Frame: total_len(u32) headers_len(u32) prelude_crc(u32) headers payload message_crc(u32)
 * Header: name_len(u8) name type(u8) value
 */

export interface StreamMessage {
  headers: Record<string, string | number | boolean>
  payload: Uint8Array
}

const decoder = new TextDecoder()

function readHeaders(view: DataView, bytes: Uint8Array, start: number, end: number) {
  const headers: StreamMessage["headers"] = {}
  let o = start
  while (o < end) {
    const nameLen = bytes[o]
    o += 1
    const name = decoder.decode(bytes.subarray(o, o + nameLen))
    o += nameLen
    const type = bytes[o]
    o += 1
    switch (type) {
      case 0:
        headers[name] = true
        break
      case 1:
        headers[name] = false
        break
      case 2:
        headers[name] = view.getInt8(o)
        o += 1
        break
      case 3:
        headers[name] = view.getInt16(o)
        o += 2
        break
      case 4:
        headers[name] = view.getInt32(o)
        o += 4
        break
      case 5:
      case 8:
        headers[name] = Number(view.getBigInt64(o))
        o += 8
        break
      case 6:
      case 7: {
        const len = view.getUint16(o)
        o += 2
        headers[name] = type === 7 ? decoder.decode(bytes.subarray(o, o + len)) : len
        o += len
        break
      }
      case 9:
        o += 16
        break
      default:
        throw new Error(`event-stream: unknown header type ${type}`)
    }
  }
  return headers
}

export class EventStreamDecoder {
  private buffer = new Uint8Array(0)

  push(chunk: Uint8Array): StreamMessage[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length)
    merged.set(this.buffer)
    merged.set(chunk, this.buffer.length)
    this.buffer = merged

    const out: StreamMessage[] = []
    while (this.buffer.length >= 12) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength)
      const total = view.getUint32(0)
      const headersLen = view.getUint32(4)
      if (total < 16 || total > 16 * 1024 * 1024) throw new Error(`event-stream: bad frame length ${total}`)
      if (this.buffer.length < total) break
      const headers = readHeaders(view, this.buffer, 12, 12 + headersLen)
      const payload = this.buffer.slice(12 + headersLen, total - 4)
      out.push({ headers, payload })
      this.buffer = this.buffer.slice(total)
    }
    return out
  }
}

/** Encoder, used by tests and the mock server. */
export function encodeMessage(headers: Record<string, string>, payload: Uint8Array | string): Uint8Array {
  const enc = new TextEncoder()
  const body = typeof payload === "string" ? enc.encode(payload) : payload
  const headerBytes: number[] = []
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name)
    const v = enc.encode(value)
    headerBytes.push(n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v)
  }
  const total = 12 + headerBytes.length + body.length + 4
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headerBytes.length)
  view.setUint32(8, crc32(out.subarray(0, 8)))
  out.set(headerBytes, 12)
  out.set(body, 12 + headerBytes.length)
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)))
  return out
}

let table: Uint32Array | undefined
function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of bytes) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
