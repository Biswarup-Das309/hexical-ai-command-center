import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

test('Supabase bearer clients avoid GoTrue storage-key collisions and reuse the current token client', async () => {
  const source = await readFile(resolve(process.cwd(), 'lib/supabase.ts'), 'utf8')

  assert.match(source, /supabaseAuthenticatedClient/)
  assert.match(source, /supabaseAuthenticatedClient\?\.token === token/)
  assert.match(source, /clerk-bearer-\$\{sequence\}/)
  assert.match(source, /auth: \{ \.\.\.clientOptions\.auth, storageKey \}/)
  assert.match(source, /realtime: \{ params: \{ eventsPerSecond: 100 \} \}/)
})
