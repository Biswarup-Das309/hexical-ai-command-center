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
