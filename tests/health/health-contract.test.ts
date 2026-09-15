import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('health reports provider configuration separately from live infrastructure health', async () => {
  const source = await readFile(new URL('../../app/api/health/route.ts', import.meta.url), 'utf8')

  assert.match(source, /status: 'configured' \| 'unconfigured'/)
  assert.match(source, /live provider probing is disabled on the normal health path/)
  assert.doesNotMatch(source, /status: configured \? 'healthy' : 'unhealthy'/)
  assert.doesNotMatch(source, /providers\.groq\.status,/)
  assert.doesNotMatch(source, /providers\.openai\.status,/)
  assert.doesNotMatch(source, /providers\.anthropic\.status,/)
})

test('transcript SSE exposes a generic public failure and logs a correlation id', async () => {
  const source = await readFile(
    new URL('../../app/api/tty/sessions/[sessionId]/transcript/stream/route.ts', import.meta.url),
    'utf8',
  )

  assert.match(source, /requestCorrelationId\(request\)/)
  assert.match(source, /log\.error\('tty\.transcript_stream_failed'/)
  assert.match(source, /sseError\('STREAM_UNAVAILABLE', 'Transcript stream temporarily unavailable\.'\)/)
  assert.doesNotMatch(source, /sseError\([^\n]*error\.message/)
})
