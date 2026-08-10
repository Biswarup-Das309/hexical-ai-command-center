import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTTYEvidenceBookmark,
  parseTTYEvidenceBookmarks,
  serializeTTYEvidenceBookmarks,
} from '@/lib/tty/tty-evidence-bookmarks'
import { buildTTYExecutionTimeline, timelineDurationLabel } from '@/lib/tty/tty-execution-timeline'
import { createTTYStreamEvent } from '@/lib/tty/tty-stream-types'
import { buildTTYTerminalLines, findTTYSearchMatches } from '@/lib/tty/tty-terminal-search'

const executionId = 'execution-1' as never
const sessionId = 'session-1' as never
function state(sequence: number, value: 'queued' | 'running' | 'streaming') {
  return createTTYStreamEvent({
    executionId,
    sessionId,
    sequence,
    timestamp: `2026-08-09T00:00:0${sequence}.000Z`,
    type: 'state',
    payload: { state: value },
  })
}
function output(sequence: number, text: string) {
  return createTTYStreamEvent({
    executionId,
    sessionId,
    sequence,
    timestamp: '2026-08-09T00:00:10.000Z',
    type: 'stdout',
    payload: { text, byteLength: text.length },
  })
}

test('timeline and search models preserve state order and partial output lines', () => {
  const timeline = buildTTYExecutionTimeline(
    [state(1, 'queued'), state(2, 'running'), state(3, 'streaming')],
    Date.parse('2026-08-09T00:00:04.000Z'),
  )
  assert.deepEqual(
    timeline.map((item) => item.state),
    ['queued', 'running', 'streaming'],
  )
  assert.equal(timelineDurationLabel(1_500), '1.50s')
  const lines = buildTTYTerminalLines([output(4, 'first\nsecond'), output(5, ' line\nthird')])
  assert.deepEqual(
    lines.map((line) => line.text),
    ['first', 'second line', 'third'],
  )
  assert.deepEqual(findTTYSearchMatches(lines, 'second'), [{ lineNumber: 2, start: 0, length: 6, sequence: 5 }])
})

test('evidence bookmarks round-trip with an execution-scoped local format', () => {
  const bookmark = createTTYEvidenceBookmark({
    executionId,
    sequence: 4,
    lineNumber: 2,
    kind: 'output',
    label: 'interesting path',
    excerpt: 'second line',
  })
  const parsed = parseTTYEvidenceBookmarks(serializeTTYEvidenceBookmarks([bookmark]), executionId)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.excerpt, 'second line')
  assert.equal(parseTTYEvidenceBookmarks(serializeTTYEvidenceBookmarks([bookmark]), 'other' as never).length, 0)
})

test('search model bounds a 100k-line output window without losing the newest line', () => {
  const large = Array.from({ length: 100_000 }, (_, index) => ({
    eventId: `event-${index}` as never,
    executionId,
    sessionId,
    sequence: index + 1,
    timestamp: '2026-08-09T00:00:00.000Z',
    type: 'stdout' as const,
    payload: { text: `line-${index}\n`, byteLength: index.toString().length + 6 },
  }))
  const lines = buildTTYTerminalLines(large, 100_000)
  assert.equal(lines.length, 100_000)
  assert.equal(lines.at(-1)?.text, 'line-99999')
  assert.equal(findTTYSearchMatches(lines, 'line-99999').length, 1)
})
