# Engineering evidence architecture

The Engineering view accepts a bounded source snapshot from an authenticated user and turns it into an owner-scoped repository graph. It is deliberately evidence-first: submitted source bodies are analyzed in memory and are not written to the database.

## Evidence contract

- `OBSERVED` means the submitted source or a persisted relationship directly contained the fact.
- `DERIVED` means a relationship was calculated from observed paths, imports, naming conventions, or graph structure.
- `INFERRED` means the graph could not establish the relationship directly and the limitation is retained with the run.
- `BLOCKED` means a checkout-dependent command could not run. The service does not claim that typecheck, lint, build, or tests ran when it only received a snapshot.

The ingestion limits are 500 files, 250,000 bytes per file, 4 MB total, 10,000 graph nodes, and 25,000 graph edges. Paths are normalized and unsafe traversal paths are ignored.

## Durable run flow

1. `POST /api/engineering/runs` authenticates with Clerk, normalizes the snapshot, persists the repository context/graph, creates an owner-scoped run, and records repository evidence.
2. `POST /api/engineering/runs/{runId}/swarm` runs the real server-side evidence roles over the persisted graph. The roles are `ARCHITECT`, `SECURITY_ENGINEER`, and `TEST_ENGINEER`; they persist input context, findings, and evidence. They do not fabricate model consensus, progress, test execution, or runtime security results.
3. `POST /api/engineering/runs/{runId}/verify` records graph/security/impact results and marks checkout-only checks `BLOCKED` unless a connected checkout implementation is supplied.
4. `GET /api/engineering/runs/{runId}` returns only the authenticated owner's run, tasks, evidence, and graph.

The role route is an evidence analysis pass, not the existing provider-backed Hexical AI swarm. Provider-backed analysis remains governed by its existing plan and request-deadline controls.

## Storage and authorization

Migration `20260919_hexical_engineering_evidence.sql` adds six tables for repository contexts, nodes, edges, runs, tasks, and evidence. Every row carries `owner_user_id`; server reads and writes apply that owner filter. RLS is enabled with service-role-only policies because the application uses the server admin client boundary. The paired rollback removes only these newly added tables and must be explicitly approved before use.

The migration has not been applied to production by this local implementation pass. Deployment requires applying the additive migration through the established Supabase migration process, then deploying the matching application commit.

## Known limits

- A client snapshot cannot prove generated-code behavior, runtime reflection, package-manager output, or command execution.
- Static security signals are review indicators, not confirmed vulnerabilities.
- Test relationships are mapped from the snapshot; the role records `NOT_RUN` until a connected verification worker executes them.
- Production/browser verification of the new Engineering view remains pending until the migration and application are intentionally deployed.
