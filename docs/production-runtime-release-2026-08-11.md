# Hexical Runtime OS release package — manual execution and evidence gates

## Release position

The repository now contains the Runtime OS execution path: transactional
admission, worker leases, persistent tmux/node-pty sessions, durable session
transcript replay, output-stream deduplication, worker recovery, and a
terminal-first Execute surface.

Local code evidence is strong, but production readiness is not yet signed off.
No Vercel, Redis, Supabase, Clerk, Linux-worker, or browser production action
has been performed from this workspace.

## Local verification recorded in this checkout

Run from the repository root:

```powershell
npm.cmd run typecheck
npm.cmd run verify:node-pty
npm.cmd run test:tty-runtime
npm.cmd run test:tty-frontend
npm.cmd run test:all
npm.cmd run format:check
npm.cmd run security:audit
npm.cmd run build
```

The current continuation verified TypeScript successfully, the real local
`node-pty` smoke successfully, the full TTY runtime suite at 72/72 tests, the
full repository suite with exit code 0, formatting, audit, and the production
build. These are local results only. The Linux/tmux worker path, worker
handoff, and deployed browser workflow remain manual gates.

## Runtime implementation

- Admission persists the execution identity and queued state before the API
  acknowledges it.
- The worker claims the execution lease and routes it to
  `TTYPersistentProcessRuntime`.
- The process bridge writes the admitted argv into the existing manager-owned
  shell and never re-dispatches argv during recovery.
- `TTYPersistentSessionManager` owns PTY lifecycle, session ownership,
  heartbeat, runtime lease, control commands, journal polling, cleanup, and
  diagnostics.
- tmux keeps the shell alive across worker attachment loss; the recovery
  service reattaches only when durable runtime history proves the shell exists.
- The session transcript is cursor-replayable and its event IDs are
  deduplicated. The separate execution output stream is also deduplicated.
- Session creation atomically enforces the canonical tier's concurrent-session
  ceiling, and `GET /api/tty/sessions` restores only the authenticated owner's
  live terminals after a browser restart. Each tab receives an independent
  persistent session rather than an alias to the owner's first shell.
- `components/tty/RuntimeOSWorkspace.tsx` is the terminal-first Execute
  surface. It renders durable timing/output metrics and execution timeline
  events when the worker emits them; unavailable process-level host telemetry
  is displayed as unavailable rather than fabricated. Investigation graph,
  notes, evidence, and timeline controls remain under the Workspace surface.

## Worker package and environment

Run manually on the Linux worker host/image, not in Vercel:

```powershell
npm.cmd ci --include=optional
node -e "import('node-pty').then(() => console.log('node-pty available'))"
tmux -V
npm.cmd run typecheck
npm.cmd run test:tty-runtime
```

Required worker variables include:

```text
TTY_PERSISTENT_PTY_ENABLED=true
TTY_RUNTIME_BACKEND=tmux
TTY_PTY_PATH=<approved executable PATH>
TTY_PTY_WORKSPACE_ROOT=<private writable worker directory>
TTY_EXECUTION_WORKER_ID=<unique worker id>
TTY_WORKER_AUTH_SECRET=<shared secret with the web app>
UPSTASH_REDIS_REST_URL=<production Redis URL>
UPSTASH_REDIS_REST_TOKEN=<production Redis token>
```

The worker must run on Linux with `tmux` installed. Keep the shared worker
secret out of Git, logs, browser diagnostics, and chat.

## Supabase additive package

After a backup and change review, run the following files manually in the
intended Supabase project, in order:

```text
supabase/migrations/20260811_hexical_runtime_os_additive.sql
supabase/repair/20260811_hexical_runtime_os_additive_repair.sql
supabase/verification/20260811_hexical_runtime_os_additive_verification.sql
```

Run the repair once only if verification reports one of its documented
repairable inconsistencies, then rerun verification. Keep
`supabase/rollback/20260811_hexical_runtime_os_additive_rollback.sql` as the
reversal package; do not run it during normal deployment and do not use a
destructive rebuild family.

## Required production smoke workflow

From a newly created investigation, use the authenticated Execute UI or the
corresponding API path to admit:

```text
echo HEXICAL_RUNTIME_OS_TEST
```

Capture the execution ID and verify, using the deployed API and worker logs:

1. one admission creates the execution and returns its queued identifier;
2. the worker claims the same identifier;
3. the existing PTY is attached and emits output;
4. the output is persisted in both the session transcript and execution stream;
5. refresh replays the transcript from its cursor;
6. disconnect/reconnect resumes without duplicate or missing bytes;
7. historical replay after completion includes the same output and terminal
   completion state;
8. no `EXECUTION_NOT_FOUND`, state divergence, or lost output occurs;
9. worker health shows the expected authenticated online worker;
10. canonical entitlement checks, RLS, and migration verification pass;
11. create up to the entitlement's terminal-tab cap, refresh, and confirm
    each restored tab retains its own session ID, cwd, and transcript;
12. exercise the production process telemetry collector before claiming CPU,
    memory, or disk monitoring is available.

The production result must be recorded separately from local test output. This
workspace cannot claim that result without the operator running it.

## Deployment order

1. Review the diff and run the local commands above.
2. Install/verify native worker dependencies on the Linux worker image.
3. Back up Supabase and apply the additive migration, repair only if needed,
   then verification.
4. Deploy the matching web commit to Vercel and wait for Ready.
5. Restart workers one at a time with the same commit and permanent auth secret.
6. Verify worker health, then run the smoke workflow.
7. Record the browser, worker, Redis, and Supabase evidence before sign-off.

## Rollback

If the smoke workflow fails, stop newly started workers, redeploy the prior
known-good web commit, and restart workers from that same commit. Use the SQL
rollback file only when the additive migration is confirmed as the cause and
its prerequisites are satisfied. Preserve the failed execution IDs, cursors,
worker logs, and verification output for incident analysis.

## Current sign-off decision

Repository implementation: in place and locally tested.

Production Runtime OS: pending native-worker, deployed-browser, Redis,
Supabase, and end-to-end smoke evidence. Do not describe the platform as
public-launch ready until those gates are completed manually.
