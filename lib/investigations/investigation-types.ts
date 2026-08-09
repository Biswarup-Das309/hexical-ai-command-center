declare const investigationIdBrand: unique symbol

export type InvestigationId = string & { readonly [investigationIdBrand]: true }

export type InvestigationStatus = 'active' | 'archived' | 'deleted'

export type InvestigationTimelineEventType =
  | 'investigation_created'
  | 'investigation_renamed'
  | 'investigation_archived'
  | 'investigation_unarchived'
  | 'investigation_deleted'
  | 'execution_queued'
  | 'execution_started'
  | 'stdout'
  | 'stderr'
  | 'execution_completed'
  | 'execution_failed'
  | 'evidence_bookmarked'
  | 'note_added'
  | 'note_edited'
  | 'note_deleted'

export interface InvestigationRecord {
  readonly investigationId: InvestigationId
  readonly ownerUserId: string
  readonly title: string
  readonly description: string
  readonly status: InvestigationStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly archivedAt: string | null
  readonly executionCount: number
  readonly evidenceCount: number
  readonly findingCount: number
}

export type InvestigationExecutionState =
  | 'queued'
  | 'leased'
  | 'starting'
  | 'running'
  | 'streaming'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'expired'
  | 'unknown'

export interface InvestigationExecution {
  readonly executionId: string
  readonly sessionId: string
  readonly state: InvestigationExecutionState
  readonly attachedAt: string
  readonly updatedAt: string
  readonly finishedAt: string | null
  readonly durationMs: number | null
}

export interface InvestigationTimelineEvent {
  readonly eventId: string
  readonly investigationId: InvestigationId
  readonly type: InvestigationTimelineEventType
  readonly occurredAt: string
  readonly executionId: string | null
  readonly sequence: number | null
  readonly payload: Readonly<Record<string, string | number | boolean | null>>
}

export interface InvestigationBookmark {
  readonly bookmarkId: string
  readonly executionId: string
  readonly sequence: number
  readonly lineNumber: number | null
  readonly kind: 'output' | 'error' | 'state' | 'finding'
  readonly label: string
  readonly excerpt: string
  readonly createdAt: string
}

export interface InvestigationNote {
  readonly noteId: string
  readonly body: string
  readonly createdAt: string
}

export interface InvestigationHydration {
  readonly investigation: InvestigationRecord
  readonly executions: readonly InvestigationExecution[]
  readonly timeline: readonly InvestigationTimelineEvent[]
  readonly bookmarks: readonly InvestigationBookmark[]
  readonly notes: readonly InvestigationNote[]
  readonly nextTimelineCursor: string | null
  readonly nextExecutionCursor: string | null
}

export interface InvestigationPage {
  readonly investigations: readonly InvestigationRecord[]
  readonly nextCursor: string | null
}

export interface InvestigationCreateInput {
  readonly title: string
  readonly description: string
}

export interface InvestigationPatchInput {
  readonly title?: string
  readonly description?: string
  readonly status?: Exclude<InvestigationStatus, 'deleted'>
}

export interface InvestigationExecutionAttachmentInput {
  readonly executionId: string
  readonly sessionId: string
  readonly attachedAt?: string
}
