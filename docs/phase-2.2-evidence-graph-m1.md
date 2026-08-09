# Phase 2.2 Evidence Graph Milestone 1

The Evidence Graph is an additive product layer above investigation persistence. It reads the existing browser-safe TTY execution projection and writes immutable, owner-scoped entities and directional relationships to the existing durable Redis deployment. TTY runtime, worker, streaming, and investigation persistence contracts remain unchanged.

## Graph model

Entities are scoped to an investigation and identified deterministically from their normalized type and canonical key. Entity records are immutable after their first successful write. Credentials are represented by a redacted kind and a stable secret fingerprint; raw credential values are never persisted or returned.

Relationships are directional and contain source, target, relationship type, execution provenance, investigation provenance, timestamp, confidence, metadata, and a deterministic identity. Replayed output therefore produces no duplicate entity or relationship records.

The Redis graph uses atomic Lua upserts for each entity and edge. Entity and edge records are paired with global, type, relationship, execution, forward-adjacency, reverse-adjacency, lookup, and processed-sequence indexes. An index cannot be written without its core record in the same mutation.

## Extraction lifecycle

```text
authorized graph request
    -> bounded investigation/execution hydration
    -> replay output in sequence order
    -> deterministic Nmap/HTTP/directory/generic extraction
    -> atomic entity and edge upserts
    -> processed sequence checkpoint
    -> bounded graph query
```

The extractor maintains only per-execution parser state during a synchronization pass, including the current Nmap host and HTTP URL. The synchronizer replays the bounded output window to reconstruct parser context, skips already checkpointed sequences, and writes new observations in batches. A failed batch is retried on the next synchronization because its checkpoint is written only after graph persistence succeeds.

## APIs

- `GET /api/investigations/[id]/graph` returns a bounded investigation graph view.
- `GET /api/investigations/[id]/graph/summary` returns counts by entity and relationship type.
- `GET /api/investigations/[id]/graph/entities` lists entities with type and cursor pagination.
- `GET /api/investigations/[id]/graph/relationships` lists relationships with relationship, execution, and cursor filters.
- `GET /api/investigations/[id]/graph/entities/[entityId]` returns an entity detail.
- `GET /api/investigations/[id]/graph/entities/[entityId]/connected` returns bounded incoming and outgoing neighbors.
- `GET /api/investigations/[id]/graph/executions/[executionId]` returns an execution-scoped relationship page.

Every route authenticates through Clerk, resolves ownership through the investigation store, applies `no-store` headers, validates identifiers and pagination, and emits generic structured errors. Public entities omit canonical lookup keys and all graph responses omit owner IDs, worker internals, lease tokens, and Redis keys.

## Workspace explorer

`EvidenceGraphPanel` provides bounded counts, entity-family exploration, entity detail selection, and connected evidence. It polls only the summary every five seconds while visible. Entity and relationship pages are loaded lazily, and no visual canvas or unbounded graph hydration is introduced in this milestone.

## Limits and operations

- Entity and relationship list pages are capped at 100 records.
- The synchronizer processes at most 50 attached executions per investigation request.
- It reads at most 100,000 output events per execution synchronization.
- The workspace explorer requests at most 40 entities or connected neighbors per view.
- Monitor Redis latency, Lua script failures, graph synchronization duration, extraction lag, processed-sequence growth, graph query latency, and owner-denial rates.
- Graph keys are durable and have no TTL. Soft-deleted investigation records remain protected by authorization and require a controlled retention policy before physical cleanup.

## Failure and recovery behavior

- Atomic entity/edge upserts make duplicate concurrent synchronizations safe.
- Checkpoints are written after graph persistence; a crash replays the unfinished event safely.
- A replacement worker or server instance reconstructs parser state by replaying the bounded durable output stream.
- Malformed output is ignored by deterministic parsers without failing the graph request.
- Missing or unauthorized investigations return not-found semantics and never reveal tenant existence.
- Redis failures return generic API errors; no internal exception text crosses the browser boundary.
