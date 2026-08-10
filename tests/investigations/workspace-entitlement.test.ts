import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveWorkspaceEntitlement } from '../../lib/workspace-entitlement'

const NOW = new Date('2026-08-09T12:00:00.000Z')
const FUTURE = '2026-09-09T12:00:00.000Z'

test('resolves an active Pro profile for the same owner identity used by TTY lifecycle', () => {
  const entitlement = resolveWorkspaceEntitlement(
    { tier: 'pro', subscription_status: 'active', current_period_end: FUTURE },
    NOW,
  )
  assert.deepEqual(entitlement, { tier: 'pro', active: true, currentPeriodEnd: FUTURE })
})

test('resolves Free and missing profiles as non-entitled', () => {
  assert.equal(
    resolveWorkspaceEntitlement({ tier: 'free', subscription_status: 'active', current_period_end: FUTURE }, NOW).tier,
    'free',
  )
  assert.deepEqual(resolveWorkspaceEntitlement(null, NOW), { tier: 'free', active: false, currentPeriodEnd: null })
})

test('uses fresh profile data after entitlement hydration so an upgraded user becomes Pro', () => {
  const free = resolveWorkspaceEntitlement(
    { tier: 'free', subscription_status: 'active', current_period_end: FUTURE },
    NOW,
  )
  const upgraded = resolveWorkspaceEntitlement(
    { tier: 'pro', subscription_status: 'active', current_period_end: FUTURE },
    NOW,
  )
  assert.equal(free.tier, 'free')
  assert.equal(upgraded.tier, 'pro')
})
