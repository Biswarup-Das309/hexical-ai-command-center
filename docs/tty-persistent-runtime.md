# Hexical Runtime OS persistent PTY boundary

The Runtime OS is a worker-owned persistent terminal boundary. It is separate
from the short-lived argv-only `TTYProcessRuntime` used by legacy execution
tests and compatibility paths.

## Runtime topology

The production worker in `scripts/tty-worker.ts` requires
`TTY_PERSISTENT_PTY_ENABLED=true` and `TTY_RUNTIME_BACKEND=tmux`. It creates:

1. `TTYTmuxRuntime`: one long-lived `/bin/bash` PTY-backed tmux session per
   logical TTY session, with a private cwd and explicit environment.
2. `TTYPersistentSessionManager`: the worker-local session registry, runtime
   lease, heartbeat, idle/limit fencing, control handling, transcript writer,
   journal cursor, and cleanup owner.
3. `TTYSessionControlConsumer` and `TTYSessionControlRouter`: durable,
   owner-authenticated `open`, `write`, `resize`, and `terminate` delivery.
4. `TTYPersistentProcessRuntime`: frames an already-admitted argv command into
   the existing shell; it never dispatches a second shell or re-dispatches a
   recovered command.
5. `TTYPersistentRecoveryService` and `TTYExecutionCoordinator`: adopt an
   expired worker lease, reattach the same tmux shell, attach the original
   execution handle, and resume the admitted execution state machine.

The browser never receives a worker lease or Redis credential. It reads the
owner-scoped session list through `GET /api/tty/sessions`, restores terminal
tabs from that list after a browser restart, reads the transcript through
`/api/tty/sessions/:sessionId/transcript`, and sends bounded controls through
`/api/tty/sessions/:sessionId/control`.

Session creation is an atomic Redis script that prunes stale owner-index
members and enforces `maxConcurrentSessions` from the canonical tier limits.
It no longer collapses every tab into one owner-wide shell: each admitted tab
has a distinct session ID, cwd, tmux shell, transcript, and runtime lease.

## State and durability contract

The runtime keeps three related records authoritative and independently
replayable:

- the session lifecycle record in the session store;
- the worker runtime lease/history and active framed-command record in Redis;
- the append-only session transcript and execution output streams.

For the tmux adapter, `pipe-pane` writes the pane byte stream to
`.hexical-output.log` inside the session's private workspace. The manager
stores a Redis byte cursor only after the transcript/output append tail has
completed. A poll that ends in the middle of UTF-8 or an execution OSC frame
replays from the incomplete frame on the next poll. Stable journal event IDs
make a retry idempotent across transcript and execution-output writers.

The transcript is the browser source of truth after refresh, browser restart,
live-broker loss, or worker attachment change. Raw stdin is intentionally not
persisted as output.

## Worker dependency boundary

`node-pty` is declared as an npm optional dependency and `tmux` is a Linux
worker-host dependency. Neither is imported into the Next.js/Vercel runtime;
the repository uses a dynamic worker-only import so local web/typecheck runs
do not load the native module. A worker startup fails closed if the optional
native module was not installed successfully.

Run this manually on the Linux worker image/host after reviewing the native
module and lockfile change:

```powershell
npm.cmd ci --include=optional
node -e "import('node-pty').then(() => console.log('node-pty available'))"
tmux -V
npm.cmd run typecheck
npm.cmd run verify:node-pty
npm.cmd run test:tty-runtime
```

The worker host also needs `tmux`, a private writable `TTY_PTY_WORKSPACE_ROOT`,
and a `TTY_PTY_PATH` containing the approved executable directories. The
worker startup fails closed if the persistent backend variables are missing or
if the platform is Windows.

## Local evidence

The repository currently verifies the manager, tmux adapter contract, control
consumer, cursor replay, output deduplication, lease recovery, coordinator
reattachment, and terminal frontend models with local tests. These tests use
fake PTYs/Redis where native or production services are unavailable; they do
not prove that a live Linux host, Redis, Vercel deployment, Supabase project,
or browser session has passed the Runtime OS smoke workflow.

The checked-in `npm.cmd run verify:node-pty` smoke additionally exercises the
real installed `node-pty` transport locally: persistent environment, stable
cwd, terminal resize, a long-running command, clean exit, and runtime cleanup.
On Windows it uses the service-safe WinPTY backend. It does not replace the
Linux `tmux` reattachment and worker-handoff gate.

## Explicit remaining release gates

- install and verify `node-pty` and `tmux` on the real Linux worker image;
- run the worker against the intended Redis/Supabase environment;
- exercise worker handoff while a long-running command and background job are
  active, then verify the same tmux session/cwd/process survives;
- verify browser refresh/reconnect and historical transcript replay against a
  deployed authenticated session, including independent multi-terminal tab
  restoration;
- verify the required `stdout`/`stderr` accounting semantics for PTY output;
- add and verify process-level CPU, memory, and disk telemetry for the live
  tmux process tree (the current monitor is intentionally limited to durable
  execution timing/output metrics and does not invent host metrics);
- collect queue, claim, PTY attach, first-byte, replay, and completion timing
  from the production observability path.

Until those operator checks pass, this is repository-implemented and locally
tested Runtime OS code, not a production sign-off.
