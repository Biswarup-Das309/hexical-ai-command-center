import assert from 'node:assert/strict'
import test from 'node:test'
import { ttySseKeepAliveFrame, ttySseKeepAliveFrameByteLength } from '@/lib/tty/tty-sse'

test('SSE keep-alive is a comment frame large enough to flush buffered delivery', () => {
  const frame = new TextDecoder().decode(ttySseKeepAliveFrame())

  assert.ok(ttySseKeepAliveFrameByteLength() > 2_048)
  assert.match(frame, /^: keep-alive /)
  assert.ok(frame.endsWith('\n\n'))
})
