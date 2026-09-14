import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { withProviderRetry } from '../../lib/hexical/providers'
import {
  createRequestDeadline,
  isRequestDeadlineExceeded,
  RequestDeadlineExceeded,
} from '../../lib/hexical/request-deadline'

function abortableOperation(counter: { value: number }): (signal: AbortSignal) => Promise<string> {
  return (signal) => {
    counter.value += 1
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
}

test('a request that finishes before its deadline succeeds and disposes its timer', async () => {
  const deadline = createRequestDeadline(undefined, 100)
  try {
    const result = await withProviderRetry('groq', async () => 'ok', deadline.signal)
    assert.equal(result.value, 'ok')
    assert.equal(deadline.signal.aborted, false)
  } finally {
    deadline.dispose()
  }
})

test('an in-flight provider attempt is aborted at the request deadline', async () => {
  const deadline = createRequestDeadline(undefined, 20)
  const calls = { value: 0 }
  try {
    await assert.rejects(withProviderRetry('groq', abortableOperation(calls), deadline.signal), (error: unknown) =>
      isRequestDeadlineExceeded(error),
    )
    assert.equal(calls.value, 1)
  } finally {
    deadline.dispose()
  }
})

test('a retry is not started after the request deadline', async () => {
  const deadline = createRequestDeadline(undefined, 20)
  let calls = 0
  try {
    await assert.rejects(
      withProviderRetry(
        'groq',
        async () => {
          calls += 1
          throw new Error('provider failed')
        },
        deadline.signal,
      ),
      (error: unknown) => isRequestDeadlineExceeded(error),
    )
    assert.equal(calls, 1)
  } finally {
    deadline.dispose()
  }
})

test('the AI path carries one signal through fallback, structured finding, and streaming boundaries', async () => {
  const providers = await readFile(resolve(process.cwd(), 'lib/hexical/providers.ts'), 'utf8')
  const route = await readFile(resolve(process.cwd(), 'app/api/verify/route.ts'), 'utf8')
  assert.match(providers, /throwIfAborted\(args\.requestSignal\)/)
  assert.match(providers, /if \(args\.requestSignal\?\.aborted \|\| isRequestDeadlineExceeded\(err\)\) throw err/)
  assert.match(providers, /requestSignal: args\.requestSignal/)
  assert.match(route, /createRequestDeadline\(req\.signal, VERIFY_REQUEST_DEADLINE_MS\)/)
  assert.match(route, /\brequestSignal,\s*onStreamingStarted:\s*handoffStreamingDeadline/)
  assert.match(route, /disposeDeadline\(\)/)
})

test('deadline failures are represented once and do not become provider-success results', async () => {
  const error = new RequestDeadlineExceeded()
  assert.equal(error.code, 'REQUEST_DEADLINE_EXCEEDED')
  assert.equal(isRequestDeadlineExceeded(error), true)
  assert.equal(isRequestDeadlineExceeded(new Error('provider failed')), false)
})
