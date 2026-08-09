# Phase 2.2 Milestone 1 — Investigation persistence

Phase 2.2 makes an investigation the durable product object while keeping the Phase 2.1 TTY runtime and worker contracts unchanged. An execution is attached to an investigation through an additive product-layer mapping; the worker job, lease payload, coordinator, stream broker, and recovery APIs are not modified.

## Data model

`InvestigationStore` persists the following record in the existing durable Redis deployment:

| Field | Meaning |
| --- | --- |
| `investigationId` | UUID public identifier |
| `ownerUserId` | server-only tenant owner |
| `title` | bounded display title |
| `description` | bounded investigation context |
| `status` | `active`, `archived`, or `deleted` |
| `createdAt` / `updatedAt` | ISO lifecycle timestamps |
| `archivedAt` | archive timestamp or `null` |
| `executionCount` | persisted counter for attached executions |
| `evidenceCount` | persisted bookmark counter |
| `findingCount` | reserved finding counter for the next evidence milestone |

The owner index and execution index are sorted sets. The timeline is an append-only Redis Stream with bounded page reads. Bookmarks have a separate sorted-set index so refresh does not need to scan the full timeline. Internal Redis keys, lease tokens, worker IDs, and runtime metadata never cross the API boundary.

## Lifecycle

```text
create investigation
    -> persist metadata and created event
    -> attach an admitted TTY execution
    -> persist execution_queued
    -> synchronize durable TTY state/output
    -> persist started, stdout/stderr, and terminal events idempotently
    -> hydrate metadata, executions, bookmarks, notes, and timeline
```

`GET /api/investigations/[id]` performs a bounded synchronization of the first execution page before hydration. The synchronizer reads only the browser-safe TTY execution projection and output stream. Reconnects and worker restarts replay the same durable events through deterministic dedupe keys.

## API

- `POST /api/investigations` creates an owned investigation.
- `GET /api/investigations` lists owned investigations with cursor pagination.
- `GET /api/investigations/[id]` hydrates a single investigation with independently paginated executions and timeline.
- `PATCH /api/investigations/[id]` renames, edits, archives, or restores an investigation.
- `DELETE /api/investigations/[id]` records a deletion tombstone and removes the item from the owner index.
- `POST /api/investigations/[id]/timeline` persists notes and evidence bookmarks.
- `POST /api/investigations/[id]/executions` composes the frozen admission API with an additive execution attachment.

Every response is `no-store`, validates bounded input, authenticates with Clerk, and returns generic structured errors. Owner mismatch is intentionally indistinguishable from not-found.

## Failure and recovery behavior

- Investigation creation removes partial metadata/index state if initialization fails.
- Execution attachment is idempotent by investigation/execution identity.
- Timeline append deduplicates before writing and removes the dedupe marker if the append fails, allowing retry.
- Deletion is a soft tombstone: audit timeline and execution history remain durable while normal reads return not-found.
- Archive and restore are explicit lifecycle events; archive does not terminate TTY sessions.
- Redis or TTY read failures return a generic API error and never expose internal error text.
- Hydration is replay-safe across browser reconnect and replacement worker processes.

## Performance and operational considerations

- List pages are capped at 50 investigations.
- Execution pages are capped at 50 records.
- Timeline reads are capped at 100 events per request.
- TTY synchronization reads at most 2,000 output events per attached execution per hydration.
- Client state retains at most 10,000 timeline events and 500 execution records.
- No API response returns unbounded Redis collections.
- Monitor Redis latency/error rate, investigation create/patch/delete failures, hydration duration, timeline append failures, attachment failures, and execution synchronization lag.
