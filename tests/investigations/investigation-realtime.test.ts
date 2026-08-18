import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { applyInvestigationRealtimeChange, type PublicInvestigation } from '@/lib/investigations/investigation-realtime'

const base: PublicInvestigation = {
  investigationId: 'investigation-one' as PublicInvestigation['investigationId'],
  title: 'Old title',
  description: '',
  status: 'active',
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  archivedAt: null,
  ttySessionId: null,
  executionCount: 2,
  evidenceCount: 3,
  findingCount: 1,
}

test('investigation Realtime updates are owner-scoped by the subscription and preserve durable counters', () => {
  const next = applyInvestigationRealtimeChange([base], {
    eventType: 'UPDATE',
    old: {},
    new: {
      id: 'investigation-one',
      title: 'New title',
      description: '',
      status: 'active',
      created_at: base.createdAt,
      updated_at: '2026-08-18T00:01:00.000Z',
      tty_session_id: null,
    },
  })

  assert.equal(next[0]?.title, 'New title')
  assert.equal(next[0]?.executionCount, 2)
  assert.equal(next[0]?.evidenceCount, 3)
  assert.equal(next[0]?.findingCount, 1)
})

test('investigation Realtime ignores stale duplicates and removes deleted rows', () => {
  const stale = applyInvestigationRealtimeChange([base], {
    eventType: 'UPDATE',
    old: {},
    new: {
      id: 'investigation-one',
      title: 'Stale title',
      description: '',
      status: 'active',
      created_at: base.createdAt,
      updated_at: base.updatedAt,
    },
  })
  assert.deepEqual(stale, [base])

  const removed = applyInvestigationRealtimeChange([base], {
    eventType: 'DELETE',
    old: { id: 'investigation-one' },
    new: {},
  })
  assert.deepEqual(removed, [])
})

test('investigation Realtime accepts the runtime-KV bridge record projection', () => {
  const next = applyInvestigationRealtimeChange([base], {
    eventType: 'UPDATE',
    old: null,
    new: {
      investigationId: base.investigationId,
      title: 'Bridge update',
      description: '',
      status: 'active',
      createdAt: base.createdAt,
      updatedAt: '2026-08-18T00:02:00.000Z',
      ttySessionId: null,
    },
  })

  assert.equal(next[0]?.title, 'Bridge update')
  assert.equal(next[0]?.executionCount, base.executionCount)
})

test('investigation Realtime bridge parses serialized runtime-KV records', async () => {
  const migration = await readFile(
    resolve(process.cwd(), 'supabase/migrations/20260818_hexical_investigation_realtime_bridge_value_fix.sql'),
    'utf8',
  )

  assert.match(migration, /jsonb_typeof\(new\.value\) = 'string'/)
  assert.match(migration, /\(new\.value #>> '\{\}'\)::jsonb/)
  assert.match(migration, /hexical:investigations:record:%/)
})
