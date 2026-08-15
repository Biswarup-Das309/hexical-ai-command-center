# Runtime OS Supabase backend

The Runtime OS coordination plane now uses Supabase Postgres as its durable
state store and Supabase Realtime as its live notification transport. The
worker still owns the persistent tmux/node-pty process; Realtime only wakes
the worker/browser and Postgres remains the replay authority.

## Migration

Apply `supabase/migrations/20260815_hexical_runtime_supabase_backend.sql` once
to the configured Supabase project. It is additive: it creates only the
`hexical_runtime_*` tables and RPC functions and adds the stream table to the
`supabase_realtime` publication. The old destructive rebuild migrations are
not modified or re-run.

The RPC boundary preserves the existing TTY key/stream contract while moving
multi-key transitions into Postgres transactions. Lease claim, renewal,
release, recovery, session caps, worker heartbeats, output deduplication,
transcript deduplication, and queue admission are all serialized by the RPC.

## Environment

The Vercel runtime and Linux worker require:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TTY_WORKER_AUTH_SECRET`

The Runtime OS worker does not read or call `UPSTASH_REDIS_REST_URL` or
`UPSTASH_REDIS_REST_TOKEN`. Those variables may remain temporarily for
non-runtime legacy features during the migration window, but they are not a
Runtime OS dependency.

## Live paths

- Browser control remains `/api/tty/sessions/:sessionId/control`.
- Historical replay remains `/api/tty/sessions/:sessionId/transcript`.
- Live transcript is `/api/tty/sessions/:sessionId/transcript/stream`.
- Execution SSE remains `/api/tty/executions/:executionId/stream`.
- The worker subscribes to the durable pending-execution and control streams.
- The broker subscribes to the live execution stream instead of polling it.

Every browser stream merges by event ID/cursor and sequence. The server replay
is opened before the Realtime listener is considered ready, and the durable
transcript remains authoritative after refresh, a stream interruption, or a
worker restart.

## Validation gate

Run the repository typecheck, lint, build, full tests, node-pty smoke/stress,
and tmux/runtime verification before applying the migration. After deployment,
verify `/api/health` reports `runtimeBackend.backend` as
`supabase_postgres_realtime`, `ttyWorker.onlineCount >= 1`, and that a fresh
terminal can execute `echo HELLO_HEXICAL_RUNTIME`, refresh, reconnect, and
continue the same tmux shell.

## Rollback

Stop the new worker, remove the `hexical_runtime_stream_entries` publication
entry, revoke the service-role RPC grants, and drop the five
`hexical_runtime_*` tables/functions only after no new worker or Vercel build
references them. Do not reset the Supabase project or alter the historical
application migrations. Rollback of code alone is safe while the additive
tables remain present.
