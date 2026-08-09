# Hexical AI TTY Live Streaming — Phase 2.1 Milestone 1

This milestone adds the browser-facing live execution stream on top of the frozen Phase 2.0 runtime APIs.

## Contract boundary

The existing execution coordinator, output stream, cancellation service, recovery manager, lease manager, and browser-safe execution projection remain unchanged. `TTYStreamingOutputStreamManager` is a substitutable observer adapter: it calls the durable Phase 2.0 output stream first, then mirrors the resulting event into the live broker.

Workers that construct the coordinator should pass the adapter anywhere the coordinator previously received `TTYOutputStreamManager`:

```text
const outputStream = new TTYStreamingOutputStreamManager(redis, liveBroker)
const coordinator = new TTYExecutionCoordinator({ ...dependencies, outputStream })
```

The durable output stream remains the execution record. The live stream is a delivery and replay projection. A broker outage cannot convert a successful execution into a runtime failure.

## Browser-safe event model

Every `TTYStreamEvent` is immutable and contains:

| Field | Meaning |
| --- | --- |
| `eventId` | Opaque unique event identifier. |
| `executionId` | Execution being observed. |
| `sessionId` | Owning TTY session. |
| `sequence` | Monotonic per-execution live cursor. |
| `timestamp` | Server event timestamp. |
| `type` | `stdout`, `stderr`, `state`, `metric`, `heartbeat`, `completion`, or `error`. |
| `payload` | Closed, type-specific browser-safe data. |

Payload validation rejects unknown fields. Worker IDs, lease IDs/tokens, PIDs, paths, environments, Redis keys, raw exceptions, and command internals are not part of the public event type.

Completion payloads include the terminal execution state plus safe exit/signal/failure fields. `heartbeat` is a keepalive event; `error` carries only a closed public code, a safe message, and recoverability.

## Broker and replay

`TTYStreamBroker` provides:

- ordered publish and subscriber delivery per execution;
- bounded in-memory hot buffers;
- Redis Stream persistence under `tty:execution:{executionId}:live-stream`;
- a monotonic sequence under `tty:execution:{executionId}:live-sequence`;
- replay by numeric sequence cursor;
- Redis polling for subscribers connected to a different application instance;
- deterministic `ok`, `gap`, and `unavailable` replay results;
- cleanup of subscriptions and cross-instance pollers.

Redis retention is bounded with `XTRIM` when the configured client exposes it. The in-memory buffer is independently bounded, so a slow viewer cannot grow process memory without limit.

## SSE protocol

The route is:

```text
GET /api/tty/executions/{executionId}/stream
```

Optional query/header inputs:

- `sessionId` — optional consistency check against the server-side execution state;
- `Last-Event-ID` — the last numeric stream sequence successfully received.

Each event is encoded as:

```text
id: 42
event: stdout
data: {"eventId":"...","executionId":"...","sessionId":"...","sequence":42,"timestamp":"...","type":"stdout","payload":{"text":"...","byteLength":3}}
retry: 3000

```

SSE heartbeats are emitted as comments during quiet periods. Runtime heartbeat events use the same validated event model when a broker heartbeat is published.

On reconnect, the manager subscribes before activating live delivery, replays events after `Last-Event-ID`, then releases any events that arrived during replay. Duplicate or already-acknowledged sequences are ignored.

If the cursor is older than the retained window, the stream closes with a browser-safe `STREAM_GAP` error event. The client should reconnect without `Last-Event-ID` to obtain the retained suffix/current completion. If Redis and the hot buffer cannot recover a requested replay, the stream emits `STREAM_UNAVAILABLE` and closes for deterministic retry behavior.

If a completion event is replayed, the SSE response closes after the completion frame. A reconnect after an already-received completion does not invent a second completion; the client can retain its acknowledged cursor.

## Authorization

Authorization is server-side and fail-closed:

1. Clerk supplies the authenticated user ID.
2. The execution state is loaded from Redis.
3. The state supplies the authoritative session ID.
4. `TTYSessionStore.getSession(sessionId, userId)` proves ownership.
5. Only active or idle sessions may subscribe.
6. Optional stream permission checks may deny the subscription.

The route never accepts a worker ID, lease token, filesystem path, process ID, or browser-supplied ownership claim.

## Backpressure policy

Each SSE connection has bounded event and byte queues. When a queue reaches its limit:

- stdout, stderr, metric, and heartbeat events are droppable;
- state and error events are retained when possible;
- completion is never evicted by droppable output and is preserved as the final frame;
- a connection that cannot retain a non-droppable event is closed, allowing a client to reconnect and replay from its last acknowledged cursor;
- idle, non-reading clients are closed after the configured idle timeout.

The runtime does not wait on browser delivery. Durable persistence and bounded broker publication keep execution resource enforcement independent from client speed.

## Verification

Focused streaming coverage includes:

- immutable event construction, strict validation, and serialization round trips;
- concurrent publish ordering and Redis replay across broker instances;
- replay-window gaps and deterministic recovery errors;
- Last-Event-ID suffix replay and malformed cursor rejection;
- ownership, inactive-session, permission, and unauthenticated denial;
- runtime output bridge preservation of the frozen Phase 2.0 API;
- slow-client dropping with completion preservation;
- mixed lifecycle/output events and 100 concurrent viewers;
- subscriber, poller, and broker cleanup.

The streaming-focused suite is run with the existing test runner plus:

```text
tests/tty/tty-stream-types.test.ts
tests/tty/tty-stream-broker.test.ts
tests/tty/tty-stream-auth.test.ts
tests/tty/tty-sse-manager.test.ts
tests/tty/tty-stream-runtime-bridge.test.ts
tests/tty/tty-stream-e2e.test.ts
```

