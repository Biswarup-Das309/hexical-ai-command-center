import assert from 'node:assert/strict'
import { test } from 'node:test'

import { InvestigationStore } from '../../lib/investigations/investigation-store'
import { investigationOwnerIndexKey, investigationRecordKey, investigationSessionKey } from '../../lib/investigations/investigation-keys'
import { FakeInvestigationRedis } from './fake-investigation-redis'

const OWNER = 'user-investigation-owner'
const OTHER_OWNER = 'user-other-owner'
const SESSION_ID = '00000000-0000-4000-8000-000000000901'
const FIXED_TIME = '2026-08-09T10:00:00.000Z'

function store(redis = new FakeInvestigationRedis()): InvestigationStore {
  return new InvestigationStore(redis)
}

test('persists investigation metadata, timeline, bookmarks, notes, and execution attachment idempotently', async () => {
  const redis = new FakeInvestigationRedis()
  const investigations = store(redis)
  const created = await investigations.create(OWNER, { title: 'Credential exposure review', description: 'Review approved evidence.' }, FIXED_TIME)

  assert.equal(created.ownerUserId, OWNER)
  assert.equal(created.status, 'active')
  const attached = await investigations.attachExecution(OWNER, created.investigationId, { executionId: '00000000-0000-4000-8000-000000000902', sessionId: SESSION_ID, attachedAt: FIXED_TIME })
  const duplicate = await investigations.attachExecution(OWNER, created.investigationId, { executionId: '00000000-0000-4000-8000-000000000902', sessionId: SESSION_ID, attachedAt: FIXED_TIME })
  assert.equal(attached?.state, 'queued')
  assert.deepEqual(duplicate, attached)

  await investigations.recordBookmark(OWNER, created.investigationId, { executionId: attached!.executionId, sequence: 4, lineNumber: 12, kind: 'finding', label: 'Credential', excerpt: 'Evidence excerpt' }, FIXED_TIME)
  await investigations.recordNote(OWNER, created.investigationId, 'Validate against a second source.', FIXED_TIME)
  const hydrated = await investigations.get(OWNER, created.investigationId)

  assert.ok(hydrated)
  assert.equal(hydrated.investigation.executionCount, 1)
  assert.equal(hydrated.investigation.evidenceCount, 1)
  assert.equal(hydrated.executions.length, 1)
  assert.equal(hydrated.bookmarks.length, 1)
  assert.equal(hydrated.notes.length, 1)
  assert.ok(hydrated.timeline.some(event => event.type === 'investigation_created'))
  assert.ok(hydrated.timeline.some(event => event.type === 'execution_queued'))
  assert.ok(hydrated.timeline.some(event => event.type === 'evidence_bookmarked'))
  assert.equal(await investigations.get(OTHER_OWNER, created.investigationId), null)
})

test('paginates investigations and execution history without loading the full index', async () => {
  const investigations = store()
  const records = await Promise.all(Array.from({ length: 5 }, (_, index) => investigations.create(OWNER, { title: `Case ${index}`, description: '' }, `2026-08-09T10:00:0${index}.000Z`)))
  const first = await investigations.list(OWNER, { limit: 2 })
  const second = await investigations.list(OWNER, { limit: 2, cursor: first.nextCursor })
  const third = await investigations.list(OWNER, { limit: 2, cursor: second.nextCursor })

  assert.equal(first.investigations.length, 2)
  assert.equal(second.investigations.length, 2)
  assert.equal(third.investigations.length, 1)
  assert.equal(new Set([...first.investigations, ...second.investigations, ...third.investigations].map(item => item.investigationId)).size, records.length)
})

test('paginates past stale owner-index entries without underfilling a page', async () => {
  const redis = new FakeInvestigationRedis()
  const investigations = store(redis)
  const first = await investigations.create(OWNER, { title: 'First visible', description: '' }, '2026-08-09T10:00:00.000Z')
  const second = await investigations.create(OWNER, { title: 'Second visible', description: '' }, '2026-08-09T10:01:00.000Z')
  const third = await investigations.create(OWNER, { title: 'Third visible', description: '' }, '2026-08-09T10:02:00.000Z')
  await redis.del(investigationRecordKey(`${third.investigationId}` as never))

  const page = await investigations.list(OWNER, { limit: 2 })

  assert.deepEqual(page.investigations.map(item => item.investigationId), [second.investigationId, first.investigationId])
  assert.equal(page.investigations.length, 2)
  assert.equal(page.nextCursor, null)
  assert.equal((await redis.zrange<string[]>(investigationOwnerIndexKey(OWNER), 0, -1, { rev: true, offset: 0, count: 10 })).includes(third.investigationId), false)
})

test('attaches one durable TTY session per investigation and removes it during deletion', async () => {
  const redis = new FakeInvestigationRedis()
  const investigations = store(redis)
  const created = await investigations.create(OWNER, { title: 'TTY session binding', description: '' }, FIXED_TIME)
  const attached = await Promise.all([
    investigations.attachSession(OWNER, created.investigationId, '00000000-0000-4000-8000-000000000921', FIXED_TIME),
    investigations.attachSession(OWNER, created.investigationId, '00000000-0000-4000-8000-000000000922', FIXED_TIME)
  ])

  assert.ok(attached[0]?.ttySessionId)
  assert.equal(attached[0]?.ttySessionId, attached[1]?.ttySessionId)
  assert.equal((await investigations.get(OWNER, created.investigationId))?.investigation.ttySessionId, attached[0]?.ttySessionId)
  assert.equal((await investigations.get(OWNER, created.investigationId))?.timeline.some(event => event.type === 'session_attached'), true)

  await investigations.delete(OWNER, created.investigationId)
  assert.equal(await redis.get(investigationSessionKey(created.investigationId)), null)
})

test('edits and deletes notes through replayable timeline events', async () => {
  const investigations = store()
  const created = await investigations.create(OWNER, { title: 'Note lifecycle', description: '' }, FIXED_TIME)
  await investigations.recordNote(OWNER, created.investigationId, 'Original note', FIXED_TIME)
  const original = (await investigations.get(OWNER, created.investigationId))?.notes[0]
  assert.ok(original)

  await investigations.updateNote(OWNER, created.investigationId, original.noteId, 'Edited note', '2026-08-09T10:01:00.000Z')
  const edited = await investigations.get(OWNER, created.investigationId)
  assert.equal(edited?.notes[0]?.body, 'Edited note')

  await investigations.deleteNote(OWNER, created.investigationId, original.noteId, '2026-08-09T10:02:00.000Z')
  const deleted = await investigations.get(OWNER, created.investigationId)
  assert.equal(deleted?.notes.length, 0)
  assert.equal(deleted?.timeline.some(event => event.type === 'note_edited'), true)
  assert.equal(deleted?.timeline.some(event => event.type === 'note_deleted'), true)
})

test('archives, restores, soft-deletes, and hides an investigation while retaining an audit timeline', async () => {
  const investigations = store()
  const created = await investigations.create(OWNER, { title: 'Archive me', description: '' }, FIXED_TIME)
  const archived = await investigations.patch(OWNER, created.investigationId, { status: 'archived' }, '2026-08-09T10:01:00.000Z')
  assert.equal(archived?.status, 'archived')
  assert.equal(archived?.archivedAt, '2026-08-09T10:01:00.000Z')
  const restored = await investigations.patch(OWNER, created.investigationId, { status: 'active' }, '2026-08-09T10:02:00.000Z')
  assert.equal(restored?.status, 'active')
  assert.equal(restored?.archivedAt, null)
  assert.equal(await investigations.delete(OWNER, created.investigationId, '2026-08-09T10:03:00.000Z'), true)
  assert.equal(await investigations.get(OWNER, created.investigationId), null)
  assert.equal((await investigations.list(OWNER)).investigations.some(item => item.investigationId === created.investigationId), false)

  const record = await investigations.get(OWNER, created.investigationId)
  assert.equal(record, null)
})

test('a fresh store instance rehydrates persisted execution state after a worker restart', async () => {
  const redis = new FakeInvestigationRedis()
  const firstStore = store(redis)
  const created = await firstStore.create(OWNER, { title: 'Restart recovery', description: '' }, FIXED_TIME)
  const executionId = '00000000-0000-4000-8000-000000000903'
  await firstStore.attachExecution(OWNER, created.investigationId, { executionId, sessionId: SESSION_ID, attachedAt: FIXED_TIME })
  await firstStore.updateExecution(OWNER, created.investigationId, executionId, 'running', { updatedAt: '2026-08-09T10:00:02.000Z' })

  const replacementStore = store(redis)
  const hydrated = await replacementStore.get(OWNER, created.investigationId)
  assert.equal(hydrated?.executions[0]?.state, 'running')
  assert.equal(hydrated?.executions[0]?.executionId, executionId)
})

test('execution history refuses to resurrect a terminal execution', async () => {
  const investigations = store()
  const created = await investigations.create(OWNER, { title: 'Terminal state guard', description: '' }, FIXED_TIME)
  const executionId = '00000000-0000-4000-8000-000000000905'
  await investigations.attachExecution(OWNER, created.investigationId, { executionId, sessionId: SESSION_ID, attachedAt: FIXED_TIME })
  await investigations.updateExecution(OWNER, created.investigationId, executionId, 'succeeded', { updatedAt: '2026-08-09T10:00:02.000Z' })
  const replayed = await investigations.updateExecution(OWNER, created.investigationId, executionId, 'queued', { updatedAt: '2026-08-09T10:00:03.000Z' })
  assert.equal(replayed?.state, 'succeeded')
  assert.equal((await investigations.get(OWNER, created.investigationId))?.executions[0]?.state, 'succeeded')
})

test('timeline synchronization is idempotent across reconnects', async () => {
  const investigations = store()
  const created = await investigations.create(OWNER, { title: 'Reconnect replay', description: '' }, FIXED_TIME)
  const executionId = '00000000-0000-4000-8000-000000000904'
  await investigations.attachExecution(OWNER, created.investigationId, { executionId, sessionId: SESSION_ID, attachedAt: FIXED_TIME })
  await investigations.recordExecutionEvent(OWNER, created.investigationId, { type: 'stdout', executionId, sequence: 1, occurredAt: '2026-08-09T10:00:01.000Z', payload: { text: 'one' } })
  await investigations.recordExecutionEvent(OWNER, created.investigationId, { type: 'stdout', executionId, sequence: 1, occurredAt: '2026-08-09T10:00:01.000Z', payload: { text: 'one' } })
  const hydration = await investigations.get(OWNER, created.investigationId)
  assert.equal(hydration?.timeline.filter(event => event.type === 'stdout').length, 1)
})
