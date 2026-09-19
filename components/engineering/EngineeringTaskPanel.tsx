'use client'

import { useAuth } from '@clerk/nextjs'
import { AlertTriangle, CheckCircle2, FileCode2, Loader2, ShieldCheck, Upload, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'

const MAX_FILES = 500
const MAX_FILE_BYTES = 250_000
const MAX_TOTAL_BYTES = 4_000_000

interface SnapshotFile {
  readonly path: string
  readonly content: string
  readonly bytes: number
}

interface RepositorySummary {
  readonly fileCount: number
  readonly directoryCount: number
  readonly symbolCount: number
  readonly routeCount: number
  readonly testCount: number
  readonly configurationCount: number
  readonly externalDependencyCount: number
  readonly unknownDependencyCount: number
}

interface RunResponse {
  readonly ok: boolean
  readonly runId?: string
  readonly repositoryId?: string
  readonly status?: string
  readonly summary?: RepositorySummary
  readonly limitations?: readonly string[]
  readonly message?: string
}

interface VerificationCheck {
  readonly check: string
  readonly status: string
  readonly summary: string
  readonly blockedReason?: string
}

interface VerificationResponse {
  readonly ok: boolean
  readonly result?: {
    readonly status: string
    readonly correlationId: string
    readonly checks: readonly VerificationCheck[]
    readonly impact: readonly {
      readonly target: string
      readonly status: string
      readonly items: readonly { item: string; category: string; direct: boolean; confidence: string }[]
      readonly limitations: readonly string[]
    }[]
  }
  readonly message?: string
}

interface SwarmRole {
  readonly role: string
  readonly objective: string
  readonly status: string
  readonly findings: readonly unknown[]
  readonly evidence: readonly { title: string; explanation: string; certainty: string }[]
  readonly confidence: number | null
}

interface SwarmResponse {
  readonly ok: boolean
  readonly mode?: string
  readonly roles?: readonly SwarmRole[]
  readonly reconciliation?: {
    readonly disagreements: readonly string[]
    readonly synthesis: Record<string, unknown>
    readonly limitations: readonly string[]
  }
  readonly message?: string
}

function humanError(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
    return body.message
  }
  return fallback
}

function statusClass(status: string): string {
  if (status === 'VERIFIED' || status === 'COMPLETED') return 'text-emerald-300'
  if (status === 'PARTIALLY_VERIFIED' || status === 'BLOCKED') return 'text-amber-300'
  return 'text-rose-300'
}

export function EngineeringTaskPanel() {
  const { getToken, isLoaded, isSignedIn } = useAuth()
  const [objective, setObjective] = useState(
    'Understand the repository structure, impact surface, and safe verification plan.',
  )
  const [repositoryKey, setRepositoryKey] = useState('local-source-snapshot')
  const [files, setFiles] = useState<readonly SnapshotFile[]>([])
  const [run, setRun] = useState<RunResponse | null>(null)
  const [verification, setVerification] = useState<VerificationResponse['result'] | null>(null)
  const [roles, setRoles] = useState<readonly SwarmRole[]>([])
  const [reconciliation, setReconciliation] = useState<SwarmResponse['reconciliation'] | null>(null)
  const [busy, setBusy] = useState<'ingest' | 'verify' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.bytes, 0), [files])

  async function authHeaders(): Promise<HeadersInit> {
    const token = await getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  async function handleFiles(input: FileList | null) {
    if (!input) return
    setError(null)
    try {
      if (input.length > MAX_FILES) throw new Error(`Choose no more than ${MAX_FILES} files.`)
      let bytes = 0
      const next: SnapshotFile[] = []
      for (const file of Array.from(input)) {
        if (file.size > MAX_FILE_BYTES)
          throw new Error(`${file.name} exceeds the ${MAX_FILE_BYTES.toLocaleString()} byte limit.`)
        bytes += file.size
        if (bytes > MAX_TOTAL_BYTES)
          throw new Error(`The selected snapshot exceeds the ${MAX_TOTAL_BYTES.toLocaleString()} byte limit.`)
        next.push({ path: file.webkitRelativePath || file.name, content: await file.text(), bytes: file.size })
      }
      setFiles(next)
      setRun(null)
      setVerification(null)
      setRoles([])
      setReconciliation(null)
    } catch (cause) {
      setFiles([])
      setError(cause instanceof Error ? cause.message : 'The selected files could not be read.')
    }
  }

  async function createRun() {
    if (!isLoaded || !isSignedIn || files.length === 0 || !objective.trim()) return
    setBusy('ingest')
    setError(null)
    setVerification(null)
    setRoles([])
    setReconciliation(null)
    try {
      const response = await fetch('/api/engineering/runs', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({
          objective: objective.trim(),
          repository: {
            repositoryKey: repositoryKey.trim() || 'local-source-snapshot',
            files: files.map(({ path, content }) => ({ path, content })),
          },
        }),
      })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) throw new Error(humanError(body, 'Repository analysis could not be completed.'))
      setRun(body as RunResponse)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Repository analysis could not be completed.')
    } finally {
      setBusy(null)
    }
  }

  async function verifyRun() {
    if (!run?.runId) return
    setBusy('verify')
    setError(null)
    try {
      const response = await fetch(`/api/engineering/runs/${encodeURIComponent(run.runId)}/verify`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({
          changedPaths: files.slice(0, 50).map((file) => file.path),
          checks: ['diff', 'graph_consistency', 'security', 'tests', 'typecheck', 'lint', 'build'],
        }),
      })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) throw new Error(humanError(body, 'Repository verification could not be completed.'))
      const result = (body as VerificationResponse).result
      if (!result) throw new Error('Verification returned no result.')
      setVerification(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Repository verification could not be completed.')
    } finally {
      setBusy(null)
    }
  }

  async function runEvidenceRoles() {
    if (!run?.runId) return
    setBusy('verify')
    setError(null)
    try {
      const response = await fetch(`/api/engineering/runs/${encodeURIComponent(run.runId)}/swarm`, {
        method: 'POST',
        cache: 'no-store',
        headers: await authHeaders(),
      })
      const body = (await response.json().catch(() => null)) as SwarmResponse | null
      if (!response.ok) throw new Error(humanError(body, 'Engineering evidence roles could not be completed.'))
      setRoles(body?.roles ?? [])
      setReconciliation(body?.reconciliation ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Engineering evidence roles could not be completed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mx-auto w-full max-w-6xl p-4 md:p-6" aria-label="Repository engineering task">
      <header className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.03] p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-cyan-200">
              <FileCode2 className="size-4" /> Repository engineering
            </div>
            <h1 className="mt-2 text-xl font-medium text-white">Context → impact → verification</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-400">
              Submit a bounded source snapshot for owner-scoped analysis. Relationships are labeled as observed or
              derived; source bodies are analyzed in memory and are not persisted.
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 font-mono text-[10px] text-zinc-500">
            <div>Observed: source and imports</div>
            <div>Derived: conventions and impact</div>
            <div>Blocked: checkout-only commands</div>
          </div>
        </div>
      </header>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-zinc-400">
              Repository key
              <input
                value={repositoryKey}
                onChange={(event) => setRepositoryKey(event.target.value)}
                maxLength={200}
                className="mt-1 w-full rounded border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white outline-none focus:border-cyan-300/50"
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Objective
              <input
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                maxLength={2000}
                className="mt-1 w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs text-white outline-none focus:border-cyan-300/50"
              />
            </label>
          </div>

          <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-cyan-300/30 bg-cyan-300/[0.03] px-4 py-8 text-center hover:border-cyan-300/60">
            <Upload className="size-5 text-cyan-200" />
            <span className="mt-2 text-sm text-zinc-200">Choose source files</span>
            <span className="mt-1 font-mono text-[10px] text-zinc-500">
              Up to {MAX_FILES} files / {(MAX_TOTAL_BYTES / 1_000_000).toFixed(0)} MB total
            </span>
            <input
              type="file"
              multiple
              className="sr-only"
              onChange={(event) => void handleFiles(event.target.files)}
            />
          </label>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-zinc-500">
            <span>
              {files.length} files selected · {totalBytes.toLocaleString()} bytes
            </span>
            {files.length > 0 && (
              <button
                type="button"
                onClick={() => setFiles([])}
                className="flex items-center gap-1 text-zinc-500 hover:text-white"
              >
                <XCircle className="size-3" /> Clear snapshot
              </button>
            )}
          </div>

          {files.length > 0 && (
            <div className="mt-3 max-h-32 overflow-y-auto rounded border border-white/10 bg-black/20 p-2 font-mono text-[10px] text-zinc-500">
              {files.slice(0, 12).map((file) => (
                <div key={file.path} className="truncate">
                  {file.path}
                </div>
              ))}
              {files.length > 12 && <div className="mt-1 text-zinc-700">+ {files.length - 12} more files</div>}
            </div>
          )}

          {error && (
            <div
              className="mt-3 flex items-start gap-2 rounded border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-200"
              role="alert"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {error}
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void createRun()}
              disabled={!isLoaded || !isSignedIn || files.length === 0 || busy !== null}
              className="rounded bg-cyan-300 px-3 py-2 text-xs font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'ingest' ? <Loader2 className="mr-1 inline size-3 animate-spin" /> : null} Analyze snapshot
            </button>
            <button
              type="button"
              onClick={() => void verifyRun()}
              disabled={!run?.runId || busy !== null}
              className="rounded border border-white/15 px-3 py-2 text-xs text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'verify' ? <Loader2 className="mr-1 inline size-3 animate-spin" /> : null} Verify evidence
            </button>
            <button
              type="button"
              onClick={() => void runEvidenceRoles()}
              disabled={!run?.runId || busy !== null}
              className="rounded border border-cyan-300/25 px-3 py-2 text-xs text-cyan-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'verify' ? <Loader2 className="mr-1 inline size-3 animate-spin" /> : null} Run evidence roles
            </button>
          </div>
          {!isLoaded || !isSignedIn ? (
            <div className="mt-2 font-mono text-[10px] text-amber-300">
              Sign in to create an owner-scoped engineering run.
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
            <ShieldCheck className="size-4 text-emerald-300" /> Run evidence
          </div>
          {!run?.runId ? (
            <div className="mt-6 rounded border border-dashed border-white/10 p-5 text-center text-sm text-zinc-600">
              No run yet. Submit a source snapshot to begin.
            </div>
          ) : (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[10px]">
                <span className="rounded border border-emerald-400/20 bg-emerald-400/5 px-2 py-1 text-emerald-200">
                  {run.status}
                </span>
                <span className="text-zinc-600">run {run.runId}</span>
              </div>
              {run.summary && (
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(
                    [
                      ['Files', run.summary.fileCount],
                      ['Symbols', run.summary.symbolCount],
                      ['Routes', run.summary.routeCount],
                      ['Tests', run.summary.testCount],
                      ['Unknown', run.summary.unknownDependencyCount],
                      ['Packages', run.summary.externalDependencyCount],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="rounded border border-white/10 bg-black/20 px-2 py-2">
                      <div className="font-mono text-[9px] uppercase text-zinc-600">{label}</div>
                      <div className="mt-1 font-mono text-lg text-cyan-100">{value}</div>
                    </div>
                  ))}
                </div>
              )}
              {run.limitations?.map((limitation) => (
                <div key={limitation} className="mt-3 text-xs leading-5 text-amber-200/80">
                  Limitation: {limitation}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {roles.length > 0 && (
        <section
          className="mt-4 rounded-xl border border-cyan-300/15 bg-black/20 p-4"
          aria-label="Engineering evidence roles"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-100">
              <ShieldCheck className="size-4 text-cyan-200" /> Durable evidence roles
            </div>
            <span className="font-mono text-[10px] text-zinc-600">
              static graph analysis · no provider consensus claimed
            </span>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            {roles.map((role) => (
              <article key={role.role} className="rounded border border-white/10 bg-black/20 p-3">
                <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase">
                  <span className="text-zinc-300">{role.role.replaceAll('_', ' ')}</span>
                  <span className={statusClass(role.status)}>{role.status}</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-zinc-400">{role.objective}</p>
                <div className="mt-2 text-[10px] leading-4 text-zinc-500">
                  {role.evidence.length} persisted evidence record(s) · confidence not calibrated
                </div>
                <div className="mt-2 text-[10px] leading-4 text-amber-200/70">
                  This role does not claim checkout execution or runtime verification.
                </div>
              </article>
            ))}
          </div>
          {reconciliation && (
            <div className="mt-3 rounded border border-white/10 bg-black/20 p-3 text-xs leading-5 text-zinc-400">
              <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-cyan-100">
                Shared-context synthesis
              </div>
              <div className="mt-1">
                {reconciliation.disagreements.length === 0
                  ? 'No disagreement detected in the deterministic shared-graph pass.'
                  : `${reconciliation.disagreements.length} disagreement(s) require review.`}
              </div>
              {reconciliation.limitations.map((limitation) => (
                <div key={limitation} className="mt-1 text-[10px] text-amber-200/70">
                  Limitation: {limitation}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {verification && (
        <section
          className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4"
          aria-label="Repository verification results"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
              {verification.status === 'VERIFIED' ? (
                <CheckCircle2 className="size-4 text-emerald-300" />
              ) : (
                <AlertTriangle className="size-4 text-amber-300" />
              )}
              Verification result <span className={statusClass(verification.status)}>{verification.status}</span>
            </div>
            <span className="font-mono text-[10px] text-zinc-600">correlation {verification.correlationId}</span>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {verification.checks.map((check) => (
              <div key={check.check} className="rounded border border-white/10 bg-black/20 p-3">
                <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase">
                  <span className="text-zinc-300">{check.check}</span>
                  <span className={statusClass(check.status)}>{check.status}</span>
                </div>
                <div className="mt-1 text-xs leading-5 text-zinc-500">{check.summary}</div>
                {check.blockedReason && <div className="mt-1 text-[10px] text-amber-200/70">{check.blockedReason}</div>}
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {verification.impact.map((impact) => (
              <div key={impact.target} className="rounded border border-white/10 p-3">
                <div className="font-mono text-xs text-cyan-100">{impact.target}</div>
                <div className="mt-1 font-mono text-[10px] text-zinc-600">
                  {impact.status} · {impact.items.length} affected items
                </div>
                {impact.items.slice(0, 5).map((item) => (
                  <div
                    key={`${impact.target}:${item.category}:${item.item}`}
                    className="mt-1 text-[10px] text-zinc-500"
                  >
                    {item.direct ? 'Direct' : 'Transitive'} {item.category}: {item.item}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 text-[10px] text-zinc-600">
            <XCircle className="size-3" /> Checkout-dependent typecheck, lint, and build checks are blocked unless a
            connected checkout/worker is supplied.
          </div>
        </section>
      )}
    </section>
  )
}
