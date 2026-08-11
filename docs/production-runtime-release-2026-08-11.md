# Hexical production runtime release — manual execution package

## Scope and release decision

This release fixes the verified Execute failure where an approved virtual
command reached `succeeded` with zero durable stdout bytes. The worker had
completed the command, but output depended on a child Node process's Windows
stdio capture. That boundary was not deterministic in the affected worker
environment.

`echo`, `clear`, `help`, `history`, `status`, and `exit` are now executed as
worker-owned virtual operations. Their output is written directly through the
same bounded, ordered, durable Redis output stream as process output. No shell,
no Node child process, and no inherited environment are used for these commands.

External allowlisted commands remain isolated argv-only subprocesses with the
existing resource guard, lease ownership, cancellation, cleanup, and output
streaming controls.

## Release contents

- `lib/tty/tty-execution-coordinator.ts`
  - direct durable output for virtual session utilities;
  - explicit `virtual_session_utility_completed` diagnostic;
  - structured virtual-command start event;
  - shared running/accounting transition for process and virtual executions.
- `tests/tty/tty-execution-coordinator.test.ts`
  - proves virtual utilities do not launch a host process.
- `tests/tty/tty-execution-e2e.test.ts`
  - proves `echo HEXICAL_EXECUTE_SMOKE_TEST` produces durable stdout with zero
    spawn attempts.

## Required environment contract

The Vercel application and every worker must share one long-lived,
cryptographically random `TTY_WORKER_AUTH_SECRET`. Generate it once, store it
in a password manager, set it in Vercel Production, and use that same value on
each worker restart. Never put it in Git, source code, an issue, browser
DevTools, screenshots, or chat.

Vercel Production environment variables:

```text
TTY_DIRECT_ACTIVATION=false
TTY_WORKER_AUTH_SECRET=<the single permanent secret>
```

The worker host must also have the existing production Redis, Supabase, and
application environment values available through `.env.local` or its secured
service configuration.

## Manual release order

1. Restore the generated TypeScript cache so it is not committed.
2. Run local validation before committing.
3. Commit and push `main`; wait for the Vercel deployment to become Ready.
4. Restart every old worker one at a time with the unchanged permanent secret.
5. Confirm the health endpoint reports at least one online worker.
6. Run the smoke command from a newly created investigation and confirm both
   visible output and durable API replay.
7. Run the Supabase verification script after the application smoke test.

## Manual Supabase package

Run the complete contents of each file in the Supabase SQL editor, in this
order, against the intended project and database. Do not combine files, omit
statements, or run the rollback file during normal deployment.

1. `supabase/migrations/20260810_hexical_definitive_rebuild.sql`
2. `supabase/repair/20260810_hexical_definitive_repair.sql`
3. `supabase/verification/20260810_hexical_definitive_verification.sql`

If verification identifies a known repairable data inconsistency, rerun the
repair file once and then rerun the verification file. The emergency reversal
file is:

```text
supabase/rollback/20260810_hexical_definitive_rollback.sql
```

Use the alternate `20260810_hexical_complete_production_*` family only if the
definitive family was not previously applied; never apply both schema families
to the same production database without reviewing their migration history.

## Explicit production smoke criteria

For a fresh investigation:

```text
echo HEXICAL_EXECUTE_SMOKE_TEST
```

Pass criteria:

- request is admitted once and returns a queued execution id;
- the worker leases, starts, streams, and succeeds the same execution id;
- the Execute panel visibly renders `HEXICAL_EXECUTE_SMOKE_TEST`;
- `GET /api/tty/executions/<executionId>/output` reports `stdoutBytes > 0` and
  includes a stdout event containing `HEXICAL_EXECUTE_SMOKE_TEST\n`;
- refresh and reconnect preserve the transcript;
- health reports `mode: worker` and `onlineCount >= 1`.

Fail criteria requiring rollback or incident investigation:

- command ends `succeeded` with `stdoutBytes: 0`;
- stream output is visible only until a refresh;
- any execution is stuck in `queued`, `leased`, `starting`, `running`, or
  `streaming` past its resource timeout;
- no worker is online;
- Vercel and worker secrets differ.

## Operational safeguards

- Run a worker as a persistent service, not an interactive developer terminal,
  before accepting customer traffic. A Windows Scheduled Task or service
  manager must restart it after host reboot or process failure.
- Rotate `TTY_WORKER_AUTH_SECRET` only as a coordinated deployment: update
  Vercel, restart all workers with the new secret, then verify health.
- Keep `TTY_DIRECT_ACTIVATION=false`; the web app must only admit jobs and the
  authenticated worker must claim them.
- Do not use browser cookies, Clerk tokens, Supabase service-role keys, Redis
  URLs, or the worker secret in diagnostics sent outside the secured team.
- Treat non-terminal execution recovery exclusively as a worker recovery
  operation. Do not manually requeue live executions.

## Rollback decision

Application rollback is safe only before running a new database migration. If
the output smoke test fails after deployment, first stop newly started workers,
redeploy the prior known-good Git commit in Vercel, and restart workers from
that same commit. Use the SQL rollback file only when the migration itself is
the confirmed cause and its documented prerequisites are satisfied.
