import type { TTYExecutionId } from './tty-types'

export type TTYEvidenceKind = 'output' | 'error' | 'state' | 'finding'

export interface TTYEvidenceBookmark {
  readonly id: string
  readonly executionId: TTYExecutionId
  readonly sequence: number
  readonly lineNumber: number | null
  readonly kind: TTYEvidenceKind
  readonly label: string
  readonly excerpt: string
  readonly createdAt: string
}

export function ttyEvidenceStorageKey(executionId: string): string {
  return `hexical:tty:evidence:${executionId}`
}

export function serializeTTYEvidenceBookmarks(bookmarks: readonly TTYEvidenceBookmark[]): string {
  return JSON.stringify(bookmarks.slice(-500))
}

export function parseTTYEvidenceBookmarks(
  raw: string | null,
  executionId: TTYExecutionId,
): readonly TTYEvidenceBookmark[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value
      .filter((item): item is TTYEvidenceBookmark => {
        if (typeof item !== 'object' || item === null) return false
        const record = item as Record<string, unknown>
        return (
          record.executionId === executionId &&
          typeof record.id === 'string' &&
          typeof record.sequence === 'number' &&
          typeof record.kind === 'string' &&
          typeof record.label === 'string' &&
          typeof record.excerpt === 'string' &&
          typeof record.createdAt === 'string'
        )
      })
      .slice(-500)
  } catch {
    return []
  }
}

export function createTTYEvidenceBookmark(input: Omit<TTYEvidenceBookmark, 'id' | 'createdAt'>): TTYEvidenceBookmark {
  return Object.freeze({ ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() })
}
