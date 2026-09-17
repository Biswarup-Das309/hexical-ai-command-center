import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

test('verification console matches the current synchronous/streaming API contract', async () => {
  const source = await readFile(resolve(process.cwd(), 'components/hexical/hexical-console.tsx'), 'utf8')
  assert.doesNotMatch(source, /\/api\/verify\/status\//)
  assert.doesNotMatch(source, /MAX_POLL_ATTEMPTS|POLL_INTERVAL_MS|INVALID_JOB_ID|POLL_TIMEOUT/)
  assert.match(source, /UNEXPECTED_ASYNC_RESPONSE/)
  assert.match(source, /VERIFY_REQUEST_TIMEOUT_MS = 90_000/)
  assert.match(source, /REQUEST_TIMEOUT/)
  assert.match(source, /No result was recorded/)
  assert.match(source, /fetch\('\/api\/entitlement', \{ cache: 'no-store' \}\)/)
  assert.match(source, /parseEntitlementTier\(payload\.tier\)/)
  assert.match(source, /setCurrentTier\('free'\)/)
  assert.match(source, /currentTier=\{currentTier\}/)
  assert.doesNotMatch(source, /from\('profiles'\)\.select\('tier'\)/)
})
