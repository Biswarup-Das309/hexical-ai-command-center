export const ENGINEERING_ACTIVE_RUN_STORAGE_KEY = 'hexical:engineering:active-run'

export interface EngineeringRunListEntry {
  readonly id: string
  readonly created_at?: string
  readonly status?: string
}

export interface EngineeringRunDetail {
  readonly run: { readonly id: string }
}

export function isEngineeringRunId(value: string | null | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
}

interface RestoreEngineeringRunOptions<T extends EngineeringRunDetail> {
  readonly preferredRunId?: string | null
  readonly listRuns: () => Promise<readonly EngineeringRunListEntry[]>
  readonly getRun: (runId: string) => Promise<T | null>
}

export async function restoreEngineeringRun<T extends EngineeringRunDetail>({
  preferredRunId,
  listRuns,
  getRun,
}: RestoreEngineeringRunOptions<T>): Promise<T | null> {
  if (isEngineeringRunId(preferredRunId)) {
    const preferred = await getRun(preferredRunId)
    if (preferred) return preferred
  }

  const runs = await listRuns()
  for (const candidate of runs) {
    if (!isEngineeringRunId(candidate.id)) continue
    const detail = await getRun(candidate.id)
    if (detail) return detail
  }
  return null
}
