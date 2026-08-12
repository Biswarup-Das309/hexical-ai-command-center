import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodePtyTmuxAdapter, TTYTmuxRuntime } from '@/lib/tty/tty-tmux-runtime'
import type { TTYSessionId } from '@/lib/tty/tty-types'
import type { TTYWorkerId } from '@/lib/tty/tty-worker-types'

const sessionId = '00000000-0000-4000-8000-000000000901' as TTYSessionId
const ownerUserId = 'local-tmux-verifier'

function waitForMarker(
  handle: { onData(callback: (data: string) => void): () => void; write(data: string): void },
  marker: string,
) {
  return new Promise<string>((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out waiting for tmux marker ${marker}.`))
    }, 15_000)
    const unsubscribe = handle.onData((data) => {
      output += data
      if (!output.includes(marker)) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(output)
    })
  })
}

async function main(): Promise<void> {
  if (process.platform !== 'linux') {
    console.log(JSON.stringify({ ok: true, skipped: true, platform: process.platform, reason: 'linux-only-tmux-gate' }))
    return
  }
  const rootDir = await mkdtemp(join(tmpdir(), 'hexical-tmux-verifier-'))
  let runtime: TTYTmuxRuntime | null = null
  try {
    const adapter = await createNodePtyTmuxAdapter()
    runtime = new TTYTmuxRuntime(adapter, { rootDir })
    const first = await runtime.createSession({
      sessionId,
      ownerUserId,
      workerId: 'local-tmux-worker-a' as TTYWorkerId,
    })
    const firstOutputPromise = waitForMarker(first, 'HEXICAL_TMUX_READY')
    first.write(
      "export HEXICAL_CONTINUITY=preserved; printf 'HEXICAL_TMUX_READY\\n'; pwd; sleep 30 & echo $! > .background.pid\n",
    )
    const firstOutput = await firstOutputPromise
    const originalCwd = first.metadata.cwd
    await runtime.detachSession(sessionId, ownerUserId)
    const recovered = await runtime.recoverSession({
      sessionId,
      ownerUserId,
      workerId: 'local-tmux-worker-b' as TTYWorkerId,
      startedAt: first.metadata.startedAt,
    })
    if (!recovered) throw new Error('tmux session was not recoverable after attachment detach.')
    const recoveredOutputPromise = waitForMarker(recovered, 'HEXICAL_TMUX_RECOVERED')
    recovered.write(
      'test "$HEXICAL_CONTINUITY" = preserved && test -s .background.pid && kill -0 "$(cat .background.pid)" && printf \'HEXICAL_TMUX_RECOVERED\\n\'\n',
    )
    const recoveredOutput = await recoveredOutputPromise
    const telemetry = await runtime.getProcessTelemetry(sessionId, ownerUserId)
    if (!telemetry || telemetry.rootPid <= 0 || telemetry.processCount < 1)
      throw new Error('tmux process telemetry unavailable.')
    if (recovered.metadata.cwd !== originalCwd) throw new Error('tmux recovery changed the session cwd.')
    console.log(
      JSON.stringify({
        ok: true,
        platform: process.platform,
        persistentShell: true,
        workerHandoff: true,
        cwdContinuity: recovered.metadata.cwd === originalCwd,
        environmentContinuity: recoveredOutput.includes('HEXICAL_TMUX_RECOVERED'),
        backgroundJobContinuity: recoveredOutput.includes('HEXICAL_TMUX_RECOVERED'),
        panePid: telemetry.rootPid,
        processCount: telemetry.processCount,
        memoryBytes: telemetry.memoryBytes,
        diskBytes: telemetry.diskBytes,
        outputBytes: Buffer.byteLength(firstOutput + recoveredOutput, 'utf8'),
      }),
    )
    await runtime.terminateSession(sessionId, ownerUserId)
  } finally {
    if (runtime) await runtime.terminateSession(sessionId, ownerUserId).catch(() => undefined)
    await rm(rootDir, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
