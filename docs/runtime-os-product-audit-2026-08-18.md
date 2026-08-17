# Hexical Runtime OS product and capacity audit

## Scope

This audit follows the native-terminal hardening pass. It records product
grouping and capacity decisions without deleting or hiding existing production
features.

## Runtime capacity decision

Runtime OS remains gated by the existing `advanced_terminal` capability, which
is currently granted only to Pro. The previous Pro ceiling of three sessions
was an accidental coupling to the three visible browser tabs, not a measured
worker limit.

The current dedicated WSL worker was measured at 12 CPUs with approximately
7.1 GB available memory. Eight idle tmux shells were created and removed in a
controlled socket; the host's available memory changed by approximately 9 MB.
The live worker remained stable at approximately 217 MB while six persistent
shells existed. Pro therefore uses an 8-session default as a measured,
conservative per-user ceiling. Execution concurrency remains independently
bounded by the worker resource guard and queue policy.

This is a per-user session ceiling, not an unlimited-worker promise. A future
multi-worker deployment should add a worker-wide admission quota before
raising it. The server returns `SESSION_CAPACITY_EXCEEDED` for session
capacity and keeps `CONCURRENCY_LIMIT_EXCEEDED` for executions within one
session, so operators and users can distinguish the two controls.

Free, Go, and Plus remain capability-locked in this release. Expanding Runtime
OS to those tiers is a product and cost decision that requires a separate
resource budget, billing review, and worker-wide quota design.

## Product inventory

### Core — KEEP and make the default workflow obvious

- Investigate: incident/problem framing, repository context, and findings.
- Workspace: investigation-first evidence, timeline, graph, and execution
  history.
- Execute / Runtime OS: terminal-first persistent Linux PTY workflow.
- Evidence and verification: durable timeline, evidence graph, and result
  review.

### Advanced — KEEP, progressively disclose

- Repository intelligence and AST visualization for code structure.
- Topology and impact views for dependency and blast-radius analysis.
- Recon dashboard, CVSS calculator, and Bug Bounty Forge for security review.
- Runtime session, execution, resource, process, and transcript diagnostics.

These features solve distinct investigation or verification problems but should
appear contextually after a user has an investigation or target, not as equal
weight primary actions.

### Expert — KEEP behind Advanced/Expert disclosure

- Swarm topology and coordinated engineering review.
- Payload mutator and authorization-scoped probing workflows.
- PTY lease, worker, tmux, recovery, and transcript-integrity diagnostics.
- Evidence bookmarks, transcript search, and execution process detail.

These are valuable to security and platform engineers but expose implementation
concepts that beginners should not need to understand.

### Experimental or review-needed — HIDE behind explicit entry points

- Swarm simulator controls.
- Day-pass and legacy upgrade surfaces.
- Low-level node/transport panels that duplicate the Runtime OS status view.

No feature is removed in this pass. The next product pass should consolidate
duplicate upgrade surfaces and make the primary path “Investigate → understand
→ execute → verify”.

## Consolidation recommendations

- Merge Runtime OS session status, worker health, and transcript integrity into
  one Advanced diagnostics view; keep the terminal itself uncluttered.
- Hide raw lease/worker/tmux terminology until an operator opens diagnostics.
- Keep Workspace investigation-first and Execute terminal-first.
- Rework capacity messaging to explain whether the user hit session capacity,
  execution concurrency, queue depth, or plan entitlement.
- Do not remove existing security or authorization gates.

## Release gates

The native terminal behavior remains covered by the existing typecheck, lint,
build, full test, node-pty, tmux, worker-restart, reconnect, and Brave matrix.
The aggregate transcript diagnostics endpoint provides event count, unique
event count, duplicate count, sequence gaps, output bytes, and worker-to-PTY
timing without returning terminal content.
