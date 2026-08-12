import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { isProtectedAppPathname } from '../lib/auth-route-policy'

test('document navigation protects dashboard routes without overmatching similar paths', () => {
  assert.equal(isProtectedAppPathname('/dashboard'), true)
  assert.equal(isProtectedAppPathname('/dashboard/settings'), true)
  assert.equal(isProtectedAppPathname('/dashboard/settings/profile'), true)
  assert.equal(isProtectedAppPathname('/dashboarder'), false)
  assert.equal(isProtectedAppPathname('/'), false)
  assert.equal(isProtectedAppPathname('/api/user/profile'), false)
})

test('Clerk proxy applies the route policy at document navigation time', async () => {
  const source = await readFile(resolve(process.cwd(), 'proxy.ts'), 'utf8')

  assert.match(source, /clerkMiddleware/)
  assert.match(source, /isProtectedAppPathname\(request\.nextUrl\.pathname\)/)
  assert.match(source, /const \{ userId, redirectToSignIn \} = await auth\(\)/)
  assert.match(source, /if \(!userId\) return redirectToSignIn\(\{ returnBackUrl: request\.url \}\)/)
})
