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
  assert.match(editor, /onChange=\{event => onTitleChange\(event\.target\.value\)\}/)
  assert.match(editor, /event\.key !== 'Enter'/)
  assert.doesNotMatch(editor, /onBlur/)
})

test('workspace and graph clear stale data after owner or investigation loss', async () => {
  const [workspace, graph] = await Promise.all([
    source('hooks/useInvestigationWorkspace.ts'),
    source('hooks/useEvidenceGraph.ts')
  ])

  assert.match(workspace, /cause\.code === 'NOT_FOUND' \|\| cause\.code === 'UNAUTHENTICATED'/)
  assert.match(workspace, /setData\(null\)/)
  assert.match(graph, /cause instanceof EvidenceGraphRequestError && cause\.status === 404/)
  assert.match(graph, /setSummary\(null\)/)
  assert.match(graph, /refreshAbortRef\.current\?\.abort\(\)/)
})

test('workspace uses the editable title control and parent sidebar receives the saved title', async () => {
  const [workspace, console, investigations] = await Promise.all([
    source('components/workspace/PersistentInvestigationWorkspace.tsx'),
    source('components/hexical/hexical-console.tsx'),
    source('hooks/useInvestigations.ts')
  ])

  assert.match(workspace, /<InvestigationTitleEditor title=\{title\}[\s\S]*onTitleChange=\{setTitle\}[\s\S]*onSave=\{\(\) => void saveMetadata\(\)\}/)
  assert.match(workspace, /await onRename\(nextTitle, description\)/)
  assert.match(console, /await investigationManager\.rename\(investigationId, title, description\)/)
  assert.match(investigations, /replaceInvestigation\(current, response\.investigation\)/)
})

test('workspace turns a failed session attach into a visible retryable license state', async () => {
  const [workspace, hook] = await Promise.all([
    source('components/workspace/PersistentInvestigationWorkspace.tsx'),
    source('hooks/useInvestigationWorkspace.ts')
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
    source('hooks/useInvestigationWorkspace.ts')
  ])

  assert.match(workspace, /const attachedSessionId = await workspace\.ensureSession\(\)/)
  assert.match(workspace, /workspace\.data\?\.investigation\.ttySessionId \?\? sessionId/)
  assert.doesNotMatch(hook, /if \(data\?\.investigation\.ttySessionId\) return data\.investigation\.ttySessionId/)
})
