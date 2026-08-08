# Hexical AI Investigation Terminal Frontend — Phase 2.1 Milestone 2

This milestone adds the browser-side Investigation Workspace terminal. It consumes the frozen SSE endpoint and browser-safe execution projection without changing runtime or streaming APIs.

## Component architecture

`components/workspace/InvestigationWorkspace.tsx` is the composition root:

- left rail: planner context, findings slot, and a host-supplied execution history list;
- center: search toolbar, execution controls, and `InvestigationTerminal`;
- right rail: timeline, browser-safe metadata, and locally persisted evidence bookmarks.

`components/tty/TerminalContainer.tsx` owns the compact engineering-tool frame. `InvestigationTerminal.tsx` mounts xterm.js only after the component is on the client, loads `@xterm/addon-fit`, fits through `ResizeObserver`, and disposes the terminal and observers on unmount.

The terminal is read-only unless an explicit `onInput` callback is supplied. This prevents an execution viewer from silently becoming a raw shell.

## Stream lifecycle

`hooks/useTTYExecutionStream.ts` creates a native `EventSource` for:

```text
/api/tty/executions/{executionId}/stream?sessionId={sessionId}
```

Native EventSource reconnects with the most recently acknowledged SSE event ID, so the backend receives `Last-Event-ID` automatically. The hook:

1. validates each browser-safe event envelope;
2. rejects events for another execution;
3. batches state updates every 32ms;
4. de-duplicates replayed sequences;
5. detects forward sequence gaps;
6. closes and requests a full replay after `STREAM_GAP` or recoverable replay failure;
7. stops reconnecting after a terminal completion;
8. exposes explicit disconnect/reconnect/clear controls.

The route’s server-side authorization remains authoritative. The browser never supplies ownership, worker identity, lease data, or runtime paths.

## Rendering pipeline

```text
SSE frame
  -> useTTYExecutionStream
  -> bounded ordered event ring
  -> InvestigationTerminal
  -> TTYTerminalRenderer
  -> xterm.js
  -> browser canvas/DOM terminal surface
```

Stdout and stderr text are written without normalizing or stripping ANSI sequences. Partial chunks remain partial chunks, allowing xterm.js to complete ANSI control sequences across writes. State, metric, completion, and error events become compact timestamped system lines. Heartbeats are intentionally silent in the terminal surface.

The renderer tracks the highest rendered sequence and ignores duplicate replay frames. Search uses the same ordered events and reconstructs partial lines before matching.

## Controls and integration points

`ExecutionControls` implements local copy, log download, clear, cancel, and restart interactions. Cancellation and restart are callback-driven:

- `onCancel` must call the existing authenticated cancellation transport;
- `onRestart` must submit a new admitted execution and mount the new execution ID;
- the terminal never fabricates an execution ID or reuses a completed execution.

This keeps the frontend compatible with the existing server-side cancellation/admission services without adding a competing backend contract.

## Timeline and metadata

`ExecutionTimeline` derives state transitions from stream state events and displays the frozen Phase 2.0 state vocabulary. `ExecutionMetadata` accepts only `TTYBrowserExecutionView` and completion stream data, so it renders execution/session IDs, timestamps, duration, output size, exit status, verification status, queue wait, and startup metrics without worker IDs, lease tokens, PIDs, paths, or internal Redis identifiers.

`ExecutionHistory` is intentionally prop-driven. The host supplies browser-safe entries and handles selection by mounting the selected execution ID; the terminal frontend does not invent a history API or persist sensitive execution records in the browser.

## Search and evidence

`buildTTYTerminalLines` reconstructs complete lines from arbitrarily split stdout/stderr chunks. `findTTYSearchMatches` returns line/offset matches without mutating terminal output. Search navigation jumps the xterm viewport to the matched line.

Evidence bookmarks are scoped by execution and stored under:

```text
localStorage["hexical:tty:evidence:{executionId}"]
```

The storage format is deliberately small and version-neutral: bookmark ID, sequence, line, kind, label, excerpt, and creation time. The component’s `onJump` and future `onChange` seams allow migration to workspace persistence later.

## Performance and memory model

- xterm scrollback is capped at 10,000 lines;
- the hook event ring is capped at 20,000 events by default;
- search line reconstruction is capped at 100,000 lines;
- React state is flushed in batches instead of once per output chunk;
- match scanning is linear in the retained line window;
- output is written incrementally; the renderer does not rebuild the terminal DOM;
- terminal, ResizeObserver, EventSource, timers, and event subscriptions are disposed together;
- replay duplicates are bounded by the event ring rather than accumulating on reconnect.

A 100,000-line model test verifies that the newest line remains searchable while memory stays bounded by the requested window.

## Verification

Frontend-focused checks cover:

- dark ANSI theme and finite scrollback;
- resize geometry under normal and invalid measurements;
- SSE URL encoding and browser-safe event parsing;
- sequence gap detection and replay de-duplication;
- ANSI preservation and partial output chunks;
- lifecycle system-line rendering;
- state timeline construction;
- partial-line search and navigation matches;
- local evidence bookmark persistence;
- 100,000-line bounded search behavior.

Run them with:

```text
npm run test:tty-frontend
```

The runtime and live-stream suites remain separate so frontend changes can be verified without weakening the Phase 2.0 or Phase 2.1.1 acceptance boundaries.
