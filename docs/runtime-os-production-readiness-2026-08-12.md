# Runtime OS production-readiness record — 2026-08-12

This record separates repository evidence from gates that require the real
Linux worker, deployed web application, Redis, Supabase, Clerk, and Brave
browser session. It is deliberately not a production sign-off by itself.

## Root causes addressed

| Incident or risk                          | Root cause                                                                                        | Remediation in this checkout                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous dashboard access                | The proxy did not own an explicit protected-route policy and return URL contract.                 | `proxy.ts`, `lib/auth-route-policy.ts`, and auth regression tests protect exact `/dashboard` and descendants with Clerk return-back URLs.            |
| `This sandbox session could not be found` | Browser recovery treated a stale session as terminal and reconnect was not single-flight.         | Runtime OS uses the canonical `ensureSession` path, idempotent recovery latches, replacement-session reconciliation, and stale-session replay retry. |
| Refresh/reconnect transcript gaps         | Replay pagination and live recovery could stop at a false continuation or replay the same cursor. | Durable session transcript uses exclusive cursors, bounded sentinel reads, event IDs, sequence checks, and deduplicated journal replay.              |
| Windows PTY zero output                   | The original control-frame encoding was consumed by Git Bash/ConPTY before the decoder saw it.    | The persistent protocol uses a printable frame boundary with legacy OSC decoding retained for rolling recovery.                                      |
| Supabase GoTrue conflicts                 | Authenticated clients were created repeatedly with colliding storage keys.                        | Public and token-authenticated Supabase clients are singleton-reused; token rotation receives a unique storage key.                                  |
| Fabricated process readouts               | The process-tree component rendered worker/PID claims without worker telemetry.                   | The component now reports unavailable until authoritative worker data exists. Linux workers sample the tmux pane tree through `/proc`.               |

## Runtime architecture and ownership

The browser owns only presentation, input intent, cursor, and reconnect state.
The API authenticates the Clerk user, verifies session ownership, and performs
atomic admission. Redis owns the durable queue, execution state, lease
metadata, ordered execution output stream, session transcript stream, and
replay cursors. The Linux worker owns lease claim/renew/finalize, tmux PTY
attachment, control commands, framed command demultiplexing, output
persistence, recovery, and cleanup. The browser live stream is an ordered
projection; durable Redis replay remains authoritative after interruption.

`Execute` is terminal-first and renders PTY output, reconnect state, replay,
execution timeline, and durable timing/resource metrics. `Workspace` remains
investigation-first and contains graph, evidence, notes, and investigation
timeline surfaces.

Admission atomically creates the execution identifier, queued state, initial
replay event, pending queue membership, session counters, idempotency records,
and rate-limit state before a successful response. A worker lease is
necessarily null until a worker claims the queued item; claim atomically adds
worker, lease, and expiry metadata. This is an intentional two-phase contract,
not an untracked execution.

PTY output is terminal output: ordinary PTYs merge stdout and stderr at the
terminal boundary. The persistent transport records those bytes as
`persistent_pty` stdout and does not invent a separate stderr channel. The
subprocess test transport preserves separate streams.

## Local evidence available in this checkout

The following commands were run successfully after the latest code changes:

```powershell
npm.cmd run typecheck
npm.cmd run test:tty-runtime
npm.cmd run verify:node-pty
npm.cmd run stress:node-pty
npm.cmd run verify:runtime-os-local
npm.cmd run verify:tmux-runtime
npm.cmd run security:audit
git diff --check
```

The Windows tmux command emits an explicit `skipped` result because the
production persistent backend is Linux plus tmux. The local Windows proof is
real node-pty/WinPTY continuity and is not substituted for Linux handoff
evidence. The local Runtime OS proof covers queued → claimed → PTY → stdout →
durable transcript/output → paginated replay → completion and reports replay
and execution latency.

## Production gates still requiring operator evidence

1. Apply and verify only the additive Supabase package after backup:
   migration, conditional repair, verification. Never run the destructive
   definitive rebuild or reset family.
2. Install optional `node-pty`, verify `tmux`, and run the worker on Linux with
   the same commit and permanent shared worker secret.
3. Verify worker registration/heartbeat, Redis queue depth, pending entries,
   active leases, and no orphaned runtime/execution records.
4. Run the deployed authenticated smoke with
   `echo HEXICAL_RUNTIME_OS_TEST`; capture one execution ID and correlate
   admission, claim, PTY attach, first byte, durable append, replay,
   reconnect, completion, and worker logs.
5. Refresh, interrupt the live stream, reconnect, and replay historical output
   in the Brave browser. Confirm no duplicates, gaps, divergence, or
   `EXECUTION_NOT_FOUND`.
6. Keep a long-running command and background job alive during worker handoff;
   verify the same tmux shell, cwd, environment, PID tree, and transcript.
7. Create the maximum entitled terminal tabs, refresh, and verify each tab
   restores its own session ID and transcript.
8. Confirm Clerk authorization, session ownership, stream authorization, RLS,
   service-role boundaries, sandbox filesystem policy, rate limits, and audit
   events with production credentials kept out of logs and browser output.

## Deployment and rollback boundary

Deploy the additive database package first, then the matching web commit, then
one worker at a time. If the smoke fails, stop newly started workers, return
the web and worker to the previous known-good commit, and use the SQL rollback
package only after confirming the additive migration is the cause. Production
health, queue, replay, and completion evidence must be recorded separately
from the local test output above.
