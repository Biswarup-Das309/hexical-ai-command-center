# Runtime OS latency pass

The interactive terminal keeps Supabase Postgres/Realtime, the persistent
Linux worker, tmux, and node-pty as its authoritative runtime path.

Browser stdin is grouped only within the current event turn and a bounded 4ms
watchdog. Enter, control bytes, and escape sequences flush immediately. Each
batch carries a monotonic per-queue sequence and timing-only identifier; raw
stdin is not written to the transcript by the browser.

The worker writes an already attached session to tmux before session touch or
stdin transcript telemetry. Those durable operations remain ordered behind the
PTY write. Journal-backed tmux output is polled at a 16ms default cadence and
continues to use the durable journal as the recovery authority.

Transcript state is flushed to React at frame cadence, while new stdout is
written directly to the xterm instance. The browser exposes timing-only output
aggregates through `window.__hexicalTTYLatency()` after output has rendered.
The snapshot contains worker-to-browser, browser-to-render, and
worker-to-render p50/p95/p99/max values; it never contains terminal contents.

Run the local benchmark with:

```powershell
npm.cmd run benchmark:runtime-os-local
```

Its PTY measurement is host-specific. Run it in the Linux worker environment
for Linux PTY timings, and report browser-to-worker network latency separately
from local queue, worker, and render processing.
