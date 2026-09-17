import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseEntitlementTier } from '../../lib/entitlement-ui'

test('accepts only known display tiers from the canonical entitlement response', () => {
  assert.equal(parseEntitlementTier('pro'), 'pro')
  assert.equal(parseEntitlementTier('free'), 'free')
})

test('fails closed when the entitlement response is missing or malformed', () => {
  assert.equal(parseEntitlementTier(undefined), 'free')
  assert.equal(parseEntitlementTier(null), 'free')
  assert.equal(parseEntitlementTier('enterprise'), 'free')
  assert.equal(parseEntitlementTier({ tier: 'pro' }), 'free')
})
