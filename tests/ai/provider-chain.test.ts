import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  classifyProviderError,
  executeSingleWithFallback,
  safeProviderErrorMessage,
  withProviderRetry,
  type ProviderCallArgs,
} from '../../lib/hexical/providers'
import type { HexicalRuntimeStore } from '../../lib/hexical/runtime-store'
import type { ModelExecutionResult, ModelRoute } from '../../lib/hexical/types'

function providerError(statusCode: number, code: string, message = `provider ${statusCode}`): Error {
  return Object.assign(new Error(message), { statusCode, data: { error: { code } } })
}

function fakeRuntime(): HexicalRuntimeStore {
  return {
    get: async () => null,
    set: async () => 'OK',
    del: async () => 1,
    incr: async () => 1,
    expire: async () => 1,
    incrby: async () => 1,
    rateLimit: async () => ({ allowed: true, remaining: 10, resetMs: Date.now() + 60_000 }),
    reserveBudget: async () => [1, 1, 10],
    reconcileBudget: async () => 0,
  } as unknown as HexicalRuntimeStore
}

const route: ModelRoute = {
  provider: 'groq',
  model: 'test-groq-model',
  mode: 'single',
  maxOutputTokens: 100,
  temperature: 0,
  complexity: 'simple',
  confidenceScore: 70,
  cacheable: false,
  reason: 'test',
}

function result(provider: 'groq' | 'deepseek'): ModelExecutionResult {
  return {
    provider,
    model: provider === 'groq' ? route.model : 'test-deepseek-model',
    mode: 'single',
    text: 'ok',
    tokensIn: 1,
    tokensOut: 1,
    confidenceScore: 90,
    fallbackTrail: [],
    providerRetryCount: 0,
  }
}

function preserveEnv(keys: string[]): () => void {
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) process.env[key] = `test-${key.toLowerCase()}`
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('permanent model errors make one provider call and no retry', async () => {
  let calls = 0
  await assert.rejects(
    withProviderRetry('groq', async () => {
      calls += 1
      throw providerError(404, 'model_not_found')
    }),
    (error: unknown) => {
      assert.equal((error as { attempts?: number }).attempts, 1)
      assert.equal((error as { classification?: string }).classification, 'permanent')
      return true
    },
  )
  assert.equal(calls, 1)
  assert.equal(classifyProviderError(providerError(401, 'invalid_api_key')).retryable, false)
  assert.equal(classifyProviderError(providerError(403, 'permission_error')).retryable, false)
})

test('transient 429 and 503 errors retain the bounded retry policy', async () => {
  for (const status of [429, 503]) {
    let calls = 0
    await assert.rejects(
      withProviderRetry('groq', async () => {
        calls += 1
        throw providerError(status, status === 429 ? 'rate_limit' : 'service_unavailable')
      }),
    )
    assert.equal(calls, 3)
    assert.equal(classifyProviderError(providerError(status, 'temporary')).classification, 'transient')
  }
})

test('fallback advances after a permanent failure without hiding the classification', async () => {
  const restoreEnv = preserveEnv(['DEEPSEEK_MAIN_MODEL'])
  const calls: ProviderCallArgs[] = []
  try {
    const output = await executeSingleWithFallback({
      runtime: fakeRuntime(),
      route,
      profile: 'recon',
      systemCtx: 'test',
      userMessage: 'test',
      cheapOnly: false,
      providerAvailable: () => true,
      providerCall: async (args) => {
        calls.push(args)
        if (args.provider === 'groq') throw providerError(404, 'model_not_found')
        return result('deepseek')
      },
    })
    assert.equal(output.provider, 'deepseek')
    assert.deepEqual(
      calls.map((call) => call.provider),
      ['groq', 'deepseek'],
    )
    assert.match(output.fallbackTrail[0] ?? '', /permanent/)
  } finally {
    restoreEnv()
  }
})

test('fallback advances after an exhausted transient provider', async () => {
  const restoreEnv = preserveEnv(['DEEPSEEK_MAIN_MODEL'])
  const calls: string[] = []
  try {
    const output = await executeSingleWithFallback({
      runtime: fakeRuntime(),
      route,
      profile: 'recon',
      systemCtx: 'test',
      userMessage: 'test',
      cheapOnly: false,
      providerAvailable: () => true,
      providerCall: async (args) => {
        calls.push(args.provider)
        if (args.provider === 'groq') {
          await withProviderRetry('groq', async () => {
            throw providerError(503, 'service_unavailable')
          })
        }
        return result('deepseek')
      },
    })
    assert.equal(output.provider, 'deepseek')
    assert.deepEqual(calls, ['groq', 'deepseek'])
    assert.match(output.fallbackTrail[0] ?? '', /transient after 3 attempt/)
  } finally {
    restoreEnv()
  }
})

test('provider diagnostics redact credentials and preserve safe metadata', () => {
  const message = safeProviderErrorMessage(
    new Error('Bearer test-bearer-value api_key=another-test-secret model_not_found'),
  )
  assert.equal(message.includes('test-bearer-value'), false)
  assert.equal(message.includes('another-test-secret'), false)
  assert.match(message, /REDACTED/)
})

test('server correlation IDs and frontend errors are real and structured', async () => {
  const routeSource = await readFile(resolve(process.cwd(), 'app/api/verify/route.ts'), 'utf8')
  const clientSource = await readFile(resolve(process.cwd(), 'components/hexical/hexical-console.tsx'), 'utf8')
  assert.match(routeSource, /const requestId = randomUUID\(\)/)
  assert.match(routeSource, /X-Hexical-Request-Id/)
  assert.match(routeSource, /requestId,\s*\n\s*\}/)
  assert.match(clientSource, /new VerifyApiError\(res\.status, errData\?\.code, serverRequestId\)/)
  assert.match(clientSource, /finalData\.requestId \|\| serverRequestId/)
  assert.doesNotMatch(clientSource, /request_id:\s*'req_'\s*\+\s*generateUniqueID\(\)/)
})
