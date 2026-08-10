import assert from 'node:assert/strict'
import test from 'node:test'
import { TERMINAL_FONT_SIZE, TERMINAL_SCROLLBACK, TERMINAL_THEME } from '@/lib/tty/TerminalTheme'
import { calculateTTYTerminalGeometry } from '@/lib/tty/tty-terminal-layout'

test('terminal theme is dark, ANSI-complete, and bounded by a finite scrollback', () => {
  assert.equal(TERMINAL_THEME.background, '#050505')
  assert.equal(TERMINAL_THEME.cursor, '#22d3ee')
  assert.equal(TERMINAL_THEME.red, '#fb7185')
  assert.equal(TERMINAL_THEME.brightCyan, '#67e8f9')
  assert.ok(TERMINAL_SCROLLBACK > 0)
  assert.ok(TERMINAL_FONT_SIZE >= 10)
})

test('terminal geometry remains usable under resize and invalid measurements', () => {
  assert.deepEqual(calculateTTYTerminalGeometry(825, 360), { cols: 100, rows: 20 })
  assert.deepEqual(calculateTTYTerminalGeometry(0, 0), { cols: 1, rows: 1 })
  assert.deepEqual(calculateTTYTerminalGeometry(Number.NaN, Number.POSITIVE_INFINITY), { cols: 1, rows: 1 })
  assert.deepEqual(calculateTTYTerminalGeometry(800, 360, 0, -1), { cols: 96, rows: 20 })
})
