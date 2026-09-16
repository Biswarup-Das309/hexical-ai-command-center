import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

test('entitlement responses are private and never cacheable', async () => {
  const source = await readFile(resolve(process.cwd(), 'app/api/entitlement/route.ts'), 'utf8')

  assert.match(source, /export const dynamic = ['"]force-dynamic['"]/)
  assert.match(source, /Cache-Control['"]\s*:\s*['"]private, no-store['"]\s*}/)
  assert.match(source, /headers:\s*ENTITLEMENT_HEADERS/)
})
