import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Linux worker supervisor preserves tmux ownership across worker restarts', async () => {
  const unit = await readFile(new URL('../../deploy/hexical-tty-worker.service', import.meta.url), 'utf8')
  assert.match(unit, /Restart=always/)
  assert.match(unit, /KillMode=process/)
  assert.match(unit, /TMUX_TMPDIR=\/var\/lib\/hexical-tty-worker\/tmux/)
  assert.match(unit, /StateDirectory=hexical-tty-worker/)
  assert.doesNotMatch(unit, /PrivateTmp=true/)
})
