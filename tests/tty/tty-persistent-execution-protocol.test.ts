import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TTYPersistentExecutionProtocolDecoder,
  serializeTTYPersistentShellExecution,
} from '../../lib/tty/tty-persistent-execution-protocol'

const token = '0123456789abcdef0123456789abcdef'

test('persistent shell protocol preserves literal argv and frames split PTY output deterministically', () => {
  const command = serializeTTYPersistentShellExecution({
    token,
    argv: ['echo', "one; $(not-a-substitution); it's literal"],
  })
  assert.match(command, /'one; \$\(not-a-substitution\); it'\\"'\\"'s literal'/)
  assert.equal(command.includes('eval'), false)

  const decoder = new TTYPersistentExecutionProtocolDecoder()
  const first = decoder.push(`shell echo\r\n\u001b]9;HEXICAL;START;${token.slice(0, 12)}`)
  assert.deepEqual(first, [{ type: 'output', text: 'shell echo\r\n' }])
  const second = decoder.push(`${token.slice(12)}\u0007hello `)
  const third = decoder.push(`world\u001b]9;HEXICAL;END;${token};7\u0007prompt$ `)

  assert.deepEqual(second, [
    { type: 'started', token, raw: `\u001b]9;HEXICAL;START;${token}\u0007` },
    { type: 'output', text: 'hello ' },
  ])
  assert.deepEqual(third, [
    { type: 'output', text: 'world' },
    { type: 'completed', token, exitCode: 7, raw: `\u001b]9;HEXICAL;END;${token};7\u0007` },
    { type: 'output', text: 'prompt$ ' },
  ])
})

test('persistent shell protocol never consumes malformed or foreign OSC text', () => {
  const decoder = new TTYPersistentExecutionProtocolDecoder()
  const malformed = '\u001b]9;HEXICAL;START;not-a-token\u0007visible'
  assert.deepEqual(decoder.push(malformed), [
    { type: 'output', text: '\u001b]9;HEXICAL;START;not-a-token\u0007' },
    { type: 'output', text: 'visible' },
  ])
})

test('persistent shell protocol exposes incomplete frame bytes for durable cursor replay', () => {
  const decoder = new TTYPersistentExecutionProtocolDecoder()
  decoder.push(`\u001b]9;HEXICAL;START;${token.slice(0, 8)}`)
  assert.ok(decoder.bufferedInputBytes() > 0)
  decoder.reset()
  assert.equal(decoder.bufferedInputBytes(), 0)
})
