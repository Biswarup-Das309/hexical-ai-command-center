import { strict as assert } from 'node:assert'
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
