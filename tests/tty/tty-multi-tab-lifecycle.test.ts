import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

test('shared-session browser cleanup is tab-local and generation guarded', async () => {
  const source = await readFile(resolve(process.cwd(), 'hooks/useTTYSessionTranscript.ts'), 'utf8')
  assert.match(source, /const prepareInputChannel = useCallback\(\s*async \(generation: number\)/)
  assert.match(source, /generation !== generationRef\.current \|\| !startedRef\.current/)
  assert.match(source, /channel\.close\(\)/)
  assert.match(source, /writeQueueRef\.current\?\.reset\(\)/)
  assert.match(source, /closeInputChannel\(\)/)
})

test('browser-tab teardown never terminates a shared session implicitly', async () => {
  const source = await readFile(resolve(process.cwd(), 'components/tty/RuntimeOSWorkspace.tsx'), 'utf8')
  assert.doesNotMatch(source, /if \(tab\.primary\) await onTerminateSession\(\)/)
  assert.match(source, /if \(!tab\.primary\) \{\s*await runtimeRequest\(/)
  assert.match(source, /onClick=\{\(\) => void terminate\(\)\}/)
  assert.doesNotMatch(source, /beforeunload|pagehide/)
  assert.doesNotMatch(source, /useEffect\([^)]*onTerminateSession/)
})

test('primary-session termination remains an explicit terminal-control action', async () => {
  const source = await readFile(
    resolve(process.cwd(), 'components/workspace/PersistentInvestigationWorkspace.tsx'),
    'utf8',
  )
  assert.match(source, /onClick=\{\(\) => void terminateSession\(\)\}/)
  assert.match(source, /onTerminateSession=\{terminateSession\}/)
})

test('Runtime OS terminate delegates primary-session cleanup to the authoritative owner API', async () => {
  const source = await readFile(resolve(process.cwd(), 'components/tty/RuntimeOSWorkspace.tsx'), 'utf8')
  assert.match(source, /if \(activeTabIsPrimary\) await onTerminateSession\(\)/)
  assert.match(source, /tab\.primary \? null : primarySessionId \?\? null/)
})
