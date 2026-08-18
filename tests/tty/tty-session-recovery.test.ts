import assert from 'node:assert/strict'
import test from 'node:test'
import { isRecoverableTTYSessionCode } from '../../lib/tty/tty-session-recovery'

test('stream recovery replaces missing, inactive, and terminated sessions', () => {
  assert.equal(isRecoverableTTYSessionCode('SESSION_NOT_FOUND'), true)
  assert.equal(isRecoverableTTYSessionCode('SESSION_NOT_ACTIVE'), true)
  assert.equal(isRecoverableTTYSessionCode('SESSION_TERMINATED'), true)
  assert.equal(isRecoverableTTYSessionCode('UNAUTHENTICATED'), false)
  assert.equal(isRecoverableTTYSessionCode(null), false)
})
