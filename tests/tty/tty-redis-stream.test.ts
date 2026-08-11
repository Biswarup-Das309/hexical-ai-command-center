import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeTTYRedisStreamEntries, normalizeTTYRedisStreamFields } from '@/lib/tty/tty-redis-stream'

test('normalizes Redis tuple and Upstash object stream responses to the same entries', () => {
  const tuple = [['1-0', ['type', 'stdout', 'sequence', '1']]]
  const object = { '1-0': { type: 'stdout', sequence: 1 } }

  assert.deepEqual(normalizeTTYRedisStreamEntries(tuple), [['1-0', ['type', 'stdout', 'sequence', '1']]])
  assert.deepEqual(normalizeTTYRedisStreamEntries(object), [['1-0', { type: 'stdout', sequence: 1 }]])
  assert.deepEqual(normalizeTTYRedisStreamFields(tuple[0]![1]), { type: 'stdout', sequence: '1' })
  assert.deepEqual(normalizeTTYRedisStreamFields(object['1-0']), { type: 'stdout', sequence: 1 })
})
