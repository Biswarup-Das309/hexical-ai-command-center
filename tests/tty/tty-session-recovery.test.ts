import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { isRecoverableTTYSessionCode } from '../../lib/tty/tty-session-recovery'

test('stream recovery replaces missing, inactive, and terminated sessions', () => {
  assert.equal(isRecoverableTTYSessionCode('SESSION_NOT_FOUND'), true)
  assert.equal(isRecoverableTTYSessionCode('SESSION_NOT_ACTIVE'), true)
  assert.equal(isRecoverableTTYSessionCode('SESSION_TERMINATED'), true)
  assert.equal(isRecoverableTTYSessionCode('UNAUTHENTICATED'), false)
  assert.equal(isRecoverableTTYSessionCode(null), false)
})

test('stale-session reconnect opens durable control before realtime input setup', async () => {
  const source = await readFile(resolve(process.cwd(), 'hooks/useTTYSessionTranscript.ts'), 'utf8')
  const openStart = source.indexOf('const open = useCallback(async () => {')
  const openEnd = source.indexOf('  }, [control, prepareInputChannel])', openStart)
  const openBlock = openStart >= 0 && openEnd >= 0 ? source.slice(openStart, openEnd) : null

  assert.ok(openBlock, 'the transcript hook must keep a dedicated open path')
  assert.match(openBlock, /control\(\{ type: 'open' \}\)/)
  assert.match(openBlock, /void prepareInputChannel\(generation\)\.catch\(\(\) => undefined\)/)
  assert.ok(
    openBlock.indexOf("control({ type: 'open' })") < openBlock.indexOf('void prepareInputChannel(generation)'),
    'durable control must not be blocked by a hanging realtime input subscription',
  )
})

test('adversarial reconnect paths bound durable open and transcript connection waits', async () => {
  const source = await readFile(resolve(process.cwd(), 'hooks/useTTYSessionTranscript.ts'), 'utf8')

  assert.match(source, /const OPEN_CONTROL_TIMEOUT_MS = 10_000/)
  assert.match(source, /const STREAM_OPEN_TIMEOUT_MS = 10_000/)
  assert.match(source, /withTimeout\(\s*control\(\{ type: 'open' \}\)/)
  assert.match(source, /The runtime control path did not respond\. Reconnecting from durable replay\./)
  assert.match(source, /streamOpenTimerRef\.current = setTimeout\(handleStreamFailure, STREAM_OPEN_TIMEOUT_MS\)/)
  assert.match(source, /if \(streamRef\.current !== source\) return/)
  assert.match(source, /streamRef\.current !== source \|\|/)
  assert.match(source, /generation !== generationRef\.current \|\| activeSessionId !== sessionIdRef\.current/)
  assert.match(source, /prepared\?\.sessionId === sessionIdRef\.current/)
  assert.match(source, /await control\(\{\s*type: 'write'/)
})
