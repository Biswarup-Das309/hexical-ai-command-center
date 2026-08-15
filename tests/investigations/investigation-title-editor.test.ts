import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

const workspaceRoot = process.cwd()

async function source(path: string): Promise<string> {
  return readFile(resolve(workspaceRoot, path), 'utf8')
}

test('title editor renders a controlled input and defers empty-title validation until save', async () => {
  const editor = await source('components/workspace/InvestigationTitleEditor.tsx')

  assert.match(editor, /<input[\s\S]*data-testid="investigation-title-input"/)
  assert.match(editor, /value=\{title\}/)
  assert.match(editor, /onChange=\{\(?event\)?\s*=> onTitleChange\(event\.target\.value\)\}/)
  assert.match(editor, /event\.key !== 'Enter'/)
  assert.doesNotMatch(editor, /onBlur/)
})

test('workspace and graph clear stale data after owner or investigation loss', async () => {
  const [workspace, graph] = await Promise.all([
    source('hooks/useInvestigationWorkspace.ts'),
    source('hooks/useEvidenceGraph.ts'),
  ])

  assert.match(workspace, /cause\.code === 'NOT_FOUND' \|\| cause\.code === 'UNAUTHENTICATED'/)
  assert.match(workspace, /setData\(null\)/)
  assert.match(graph, /setSummary\(null\)/)
  assert.match(graph, /A failed refresh must not leave counts/)
  assert.match(graph, /clearGraphData\(\)/)
  assert.match(graph, /refreshAbortRef\.current\?\.abort\(\)/)
})

test('workspace uses the editable title control and parent sidebar receives the saved title', async () => {
  const [workspace, console, investigations] = await Promise.all([
    source('components/workspace/PersistentInvestigationWorkspace.tsx'),
    source('components/hexical/hexical-console.tsx'),
    source('hooks/useInvestigations.ts'),
  ])

  assert.match(
    workspace,
    /<InvestigationTitleEditor[\s\S]*title=\{title\}[\s\S]*onTitleChange=\{setTitle\}[\s\S]*onSave=\{\(\) => void saveMetadata\(\)\}/,
  )
  assert.match(workspace, /await onRename\(nextTitle, description\)/)
  assert.match(console, /await investigationManager\.rename\(investigationId, title, description\)/)
  assert.match(investigations, /replaceInvestigation\(current, response\.investigation\)/)
})

test('workspace turns a failed session attach into a visible retryable license state', async () => {
  const [workspace, hook] = await Promise.all([
    source('components/workspace/PersistentInvestigationWorkspace.tsx'),
    source('hooks/useInvestigationWorkspace.ts'),
  ])

  assert.match(hook, /readonly sessionFailure: InvestigationSessionFailure \| null/)
  assert.match(hook, /\{ code: cause\.code, message: cause\.message \}/)
  assert.match(workspace, /sessionFailure \? 'session unavailable' : 'attaching session'/)
  assert.match(workspace, /sessionFailure\.code === 'CAPABILITY_LOCKED'/)
  assert.match(workspace, /Retry session/)
})

test('workspace validates the persisted session before every execution so terminated sessions can rebind automatically', async () => {
  const [workspace, hook] = await Promise.all([
    source('components/workspace/PersistentInvestigationWorkspace.tsx'),
    source('hooks/useInvestigationWorkspace.ts'),
  ])

  assert.match(workspace, /const attachedSessionId = await workspace\.ensureSession\(\)/)
  assert.match(
    workspace,
    /const activeSessionId = workspace\.data \? workspace\.data\.investigation\.ttySessionId : sessionId \?\? null/,
  )
  assert.doesNotMatch(hook, /if \(data\?\.investigation\.ttySessionId\) return data\.investigation\.ttySessionId/)
})

test('terminated execution streams clear stale browser state', async () => {
  const stream = await source('hooks/useTTYExecutionStream.ts')

  assert.match(stream, /code === 'SESSION_NOT_ACTIVE' \|\| code === 'SESSION_NOT_FOUND'/)
  assert.match(stream, /handleExecutionNotFound\(\)/)
})

test('runtime transcript recovery rebinds a missing persisted session through investigation ensure', async () => {
  const [runtime, transcript, workspace] = await Promise.all([
    source('components/tty/RuntimeOSWorkspace.tsx'),
    source('hooks/useTTYSessionTranscript.ts'),
    source('components/workspace/PersistentInvestigationWorkspace.tsx'),
  ])

  assert.match(runtime, /useTTYSessionTranscript\(activeSessionId, recoverActiveSession\)/)
  assert.match(runtime, /tab\.id === staleSessionId \? \{ \.\.\.tab, id: nextId \} : tab/)
  assert.match(runtime, /method: 'POST'/)
  assert.match(transcript, /cause\.code === 'SESSION_NOT_FOUND' \|\| cause\.code === 'SESSION_NOT_ACTIVE'/)
  assert.match(transcript, /onSessionUnavailableRef\.current\(\)/)
  assert.match(transcript, /recoveryAttemptRef\.current = false/)
  assert.match(transcript, /new EventSource\(/)
  assert.match(transcript, /transcript\/stream/)
  assert.match(transcript, /connectStreamRef\.current\?\.\(\)/)
  assert.match(workspace, /onRecoverSession=\{async \(\) => \{[\s\S]*await workspace\.ensureSession\(\)/)
})

test('runtime hides a stale session error after recovery binds a live session', async () => {
  const runtime = await source('components/tty/RuntimeOSWorkspace.tsx')

  assert.match(runtime, /const visibleSessionError = activeSessionId \? null : sessionError/)
  assert.match(runtime, /visibleSessionError \|\| transcript\.error \|\| controlError \|\| executionError/)
})

test('stream recovery does not reconnect merely because the parent callback identity changed', async () => {
  const stream = await source('hooks/useTTYExecutionStream.ts')

  assert.match(stream, /const onExecutionNotFoundRef = useRef\(onExecutionNotFound\)/)
  assert.match(stream, /onExecutionNotFoundRef\.current\?\.\(\)/)
  assert.match(stream, /\}, \[\]\)/)
})
