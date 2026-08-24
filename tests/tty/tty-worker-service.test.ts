import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('Linux worker supervisor preserves tmux ownership across worker restarts', async () => {
  const unit = await readFile(new URL('../../deploy/hexical-tty-worker.service', import.meta.url), 'utf8')
  assert.match(unit, /Restart=always/)
  assert.match(unit, /KillMode=process/)
  assert.match(unit, /TMUX_TMPDIR=\/var\/lib\/hexical-tty-worker\/tmux/)
  assert.match(unit, /StateDirectory=hexical-tty-worker/)
  assert.doesNotMatch(unit, /PrivateTmp=true/)
})

test('Linux worker runtime imports without the Next server-only boundary', async () => {
  const result = await execFileAsync(
    process.execPath,
    [
      '--experimental-transform-types',
      '--import',
      './scripts/register-alias.mjs',
      '--input-type=module',
      '-e',
      "await import('./lib/tty/supabase-runtime-store.ts')",
    ],
    { cwd: process.cwd() },
  )
  assert.doesNotMatch(result.stderr, /server-only|Client Component module/)
})
