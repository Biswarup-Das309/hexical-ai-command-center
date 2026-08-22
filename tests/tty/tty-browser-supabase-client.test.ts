import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

test('PTY browser input reuses the shared public Supabase client', async () => {
  const source = await readFile(resolve(process.cwd(), 'lib/tty/tty-browser-input-channel.ts'), 'utf8')
  assert.match(source, /createSupabaseClient/)
  assert.doesNotMatch(source, /createClient\(/)
  assert.doesNotMatch(source, /GLOBAL_BROWSER_CLIENT_KEY/)
})
