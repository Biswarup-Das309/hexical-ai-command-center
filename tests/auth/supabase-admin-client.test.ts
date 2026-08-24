import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

test('server Supabase admin clients are centralized and sessionless', async () => {
  const source = await readFile(resolve(process.cwd(), 'lib/supabase-admin.ts'), 'utf8')
  const implementation = await readFile(resolve(process.cwd(), 'lib/supabase-admin-runtime.ts'), 'utf8')
  assert.match(source, /import ['"]server-only['"]|from ['"]server-only['"]/)
  assert.match(source, /supabase-admin-runtime/)
  assert.match(implementation, /GLOBAL_ADMIN_CLIENT_KEY/)
  assert.match(implementation, /persistSession: false/)
  assert.match(implementation, /autoRefreshToken: false/)
  assert.match(implementation, /storageKey: 'hexical-server-admin'/)
})

test('server service-role call sites use the shared admin client boundary', async () => {
  const files = [
    'lib/get-user-tier.ts',
    'lib/tty/tty-execution-admission-server.ts',
    'app/api/entitlement/route.ts',
    'app/api/checkout/route.ts',
    'app/api/user/profile/route.ts',
    'app/api/verify-payment/route.ts',
    'app/api/verify/webhooks/razorpay/route.ts',
    'lib/tty/supabase-runtime-store.ts',
  ]
  for (const file of files) {
    const source = await readFile(resolve(process.cwd(), file), 'utf8')
    assert.doesNotMatch(source, /createClient\(/, file)
    assert.match(source, /createSupabaseAdminClient|createSupabaseRuntimeClient|supabase-admin-runtime/, file)
  }
})
