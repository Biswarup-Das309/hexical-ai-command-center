import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getCanonicalEntitlement } from '../../lib/canonical-entitlement'

const NOW = new Date('2026-08-11T10:00:00.000Z')

function createSupabaseStub(
  result: { data: unknown; error: unknown },
  bootstrap: { readonly error: unknown } = { error: null },
) {
  let profileReads = 0
  const canonicalQuery = { maybeSingle: async () => result }
  const client = {
    rpc: (name: string) => {
      if (name === 'hexical_ensure_profile') return Promise.resolve(bootstrap)
      if (name === 'canonical_entitlement') return canonicalQuery
      throw new Error(`Unexpected RPC: ${name}`)
    },
    from: (table: string) => {
      if (table === 'profiles') profileReads += 1
      throw new Error(`Profiles must not be used for entitlement resolution: ${table}`)
    },
  }
  return { client, getProfileReads: () => profileReads }
}

test('uses canonical subscription entitlement rather than the profile mirror', async () => {
  const stub = createSupabaseStub({
    data: {
      tier: 'pro',
      status: 'active',
      current_period_end: '2026-09-11T10:00:00.000Z',
      enterprise_unlimited: false,
    },
    error: null,
  })

  const entitlement = await getCanonicalEntitlement(stub.client as never, 'user_test', NOW)

  assert.deepEqual(entitlement, { tier: 'pro', active: true, currentPeriodEnd: '2026-09-11T10:00:00.000Z' })
  assert.equal(stub.getProfileReads(), 0)
})

test('fails closed when the canonical entitlement function is unavailable', async () => {
  const stub = createSupabaseStub({ data: null, error: { message: 'function missing' } })

  const entitlement = await getCanonicalEntitlement(stub.client as never, 'user_test', NOW)

  assert.deepEqual(entitlement, { tier: 'free', active: false, currentPeriodEnd: null })
  assert.equal(stub.getProfileReads(), 0)
})

test('never writes or reads the profile mirror when provisioning is unavailable', async () => {
  const stub = createSupabaseStub(
    { data: null, error: { message: 'canonical function missing' } },
    { error: { message: 'bootstrap function missing' } },
  )

  const entitlement = await getCanonicalEntitlement(stub.client as never, 'user_test', NOW)

  assert.deepEqual(entitlement, { tier: 'free', active: false, currentPeriodEnd: null })
  assert.equal(stub.getProfileReads(), 0)
})

test('preserves enterprise access through the bounded runtime policy', async () => {
  const stub = createSupabaseStub({
    data: { tier: 'enterprise', status: 'active', current_period_end: null, enterprise_unlimited: true },
    error: null,
  })

  const entitlement = await getCanonicalEntitlement(stub.client as never, 'user_enterprise', NOW)

  assert.deepEqual(entitlement, { tier: 'pro', active: true, currentPeriodEnd: null })
})
