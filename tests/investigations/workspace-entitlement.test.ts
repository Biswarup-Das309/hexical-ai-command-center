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

test('accepts canonical trial and grace statuses through their valid period', () => {
  for (const subscription_status of ['trialing', 'grace']) {
    assert.deepEqual(
      resolveWorkspaceEntitlement({ tier: 'pro', subscription_status, current_period_end: FUTURE }, NOW),
      { tier: 'pro', active: true, currentPeriodEnd: FUTURE },
    )
  }
})

test('maps an unlimited enterprise contract to bounded Pro runtime access', () => {
  assert.deepEqual(
    resolveWorkspaceEntitlement(
      {
        tier: 'enterprise',
        subscription_status: 'active',
        current_period_end: null,
        enterprise_unlimited: true,
      },
      NOW,
    ),
    { tier: 'pro', active: true, currentPeriodEnd: null },
  )
})
