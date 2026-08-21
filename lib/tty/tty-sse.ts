/**
 * SSE keep-alives must be large enough to cross buffering intermediaries.
 *
 * EventSource ignores comment frames, so this padding is protocol-safe. The
 * frame is deliberately larger than the small-chunk thresholds used by
 * browser/CDN layers; without it, live PTY output can be durable immediately
 * but remain invisible until unrelated transcript data fills the buffer.
 */
const SSE_BUFFER_FLUSH_BYTES = 2_048
const SSE_KEEPALIVE_FRAME = `: keep-alive ${' '.repeat(SSE_BUFFER_FLUSH_BYTES)}\n\n`

export function ttySseKeepAliveFrame(): Uint8Array {
  return new TextEncoder().encode(SSE_KEEPALIVE_FRAME)
}

export function ttySseKeepAliveFrameByteLength(): number {
  return Buffer.byteLength(SSE_KEEPALIVE_FRAME, 'utf8')
}
