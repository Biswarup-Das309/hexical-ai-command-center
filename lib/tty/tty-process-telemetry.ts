import { readdir, readFile, statfs } from 'node:fs/promises'

export interface TTYProcessTelemetrySnapshot {
  readonly source: 'linux_procfs'
  readonly sampledAt: string
  readonly rootPid: number
  readonly processCount: number
  readonly cpuPercent: number | null
  readonly memoryBytes: number
  readonly diskBytes: number
}

export interface TTYProcessTelemetryOptions {
  readonly now?: () => Date
  readonly readFile?: typeof readFile
  readonly readdir?: typeof readdir
  readonly statfs?: typeof statfs
  readonly cpuCount?: number
  readonly clockTicksPerSecond?: number
}

interface ProcStat {
  readonly pid: number
  readonly parentPid: number
  readonly totalCpuTicks: number
  readonly residentPages: number
}

interface PreviousSample {
  readonly totalCpuTicks: number
  readonly sampledAtMs: number
}

function parseInteger(value: string): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

/** Parses Linux /proc/<pid>/stat without trusting the comm field's spaces. */
export function parseLinuxProcStat(value: string): ProcStat | null {
  const closeParen = value.lastIndexOf(')')
  if (closeParen < 0) return null
  const fields = value
    .slice(closeParen + 2)
    .trim()
    .split(/\s+/)
  const parentPid = parseInteger(fields[1] ?? '')
  const userTicks = parseInteger(fields[11] ?? '')
  const systemTicks = parseInteger(fields[12] ?? '')
  const residentPages = parseInteger(fields[21] ?? '')
  const pidText = value.slice(0, value.indexOf(' '))
  const pid = parseInteger(pidText)
  if (pid === null || parentPid === null || userTicks === null || systemTicks === null || residentPages === null)
    return null
  return { pid, parentPid, totalCpuTicks: userTicks + systemTicks, residentPages }
}

function processIds(value: readonly ProcStat[], rootPid: number): readonly number[] {
  const children = new Map<number, number[]>()
  for (const process of value) {
    const list = children.get(process.parentPid) ?? []
    list.push(process.pid)
    children.set(process.parentPid, list)
  }
  const result: number[] = []
  const pending = [rootPid]
  const seen = new Set<number>()
  while (pending.length > 0) {
    const pid = pending.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    result.push(pid)
    for (const child of children.get(pid) ?? []) pending.push(child)
  }
  return result
}

function numericProcDirectory(name: string): boolean {
  return /^\d+$/.test(name)
}

/**
 * Samples the tmux pane's process tree without invoking a shell. This is
 * intentionally Linux-only and returns null when the host cannot provide
 * authoritative process data.
 */
export class TTYLinuxProcessTelemetryCollector {
  private readonly previous = new Map<number, PreviousSample>()
  private readonly now: () => Date
  private readonly readFileImpl: typeof readFile
  private readonly readdirImpl: typeof readdir
  private readonly statfsImpl: typeof statfs
  private readonly cpuCount: number
  private readonly clockTicksPerSecond: number

  constructor(options: TTYProcessTelemetryOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.readFileImpl = options.readFile ?? readFile
    this.readdirImpl = options.readdir ?? readdir
    this.statfsImpl = options.statfs ?? statfs
    this.cpuCount = Math.max(1, Math.floor(options.cpuCount ?? 1))
    this.clockTicksPerSecond = Math.max(1, Math.floor(options.clockTicksPerSecond ?? 100))
  }

  async sample(rootPid: number, cwd: string): Promise<TTYProcessTelemetrySnapshot | null> {
    if (process.platform !== 'linux' || !Number.isSafeInteger(rootPid) || rootPid <= 0) return null
    const sampledAt = this.now()
    const entries = await this.readdirImpl('/proc', { withFileTypes: true })
    const stats: ProcStat[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !numericProcDirectory(entry.name)) continue
      try {
        const raw = await this.readFileImpl(`/proc/${entry.name}/stat`, 'utf8')
        const parsed = parseLinuxProcStat(raw)
        if (parsed) stats.push(parsed)
      } catch {
        // Processes can disappear between /proc enumeration and stat read.
      }
    }
    const selected = new Set(processIds(stats, rootPid))
    const tree = stats.filter((process) => selected.has(process.pid))
    if (tree.length === 0) return null

    const totalCpuTicks = tree.reduce((sum, process) => sum + process.totalCpuTicks, 0)
    const previous = this.previous.get(rootPid)
    this.previous.set(rootPid, { totalCpuTicks, sampledAtMs: sampledAt.getTime() })
    const elapsedMs = previous === undefined ? 0 : sampledAt.getTime() - previous.sampledAtMs
    const cpuPercent =
      previous === undefined || elapsedMs <= 0
        ? null
        : Math.max(
            0,
            Math.min(
              100 * this.cpuCount,
              ((totalCpuTicks - previous.totalCpuTicks) / this.clockTicksPerSecond / (elapsedMs / 1_000)) * 100,
            ),
          )
    let diskBytes = 0
    try {
      const disk = await this.statfsImpl(cwd)
      const blockSize = Number(disk.bsize)
      const blocks = Number(disk.blocks)
      const available = Number(disk.bavail)
      if ([blockSize, blocks, available].every((value) => Number.isSafeInteger(value) && value >= 0))
        diskBytes = Math.max(0, (blocks - available) * blockSize)
    } catch {
      // Disk telemetry is optional; process identity and memory remain useful.
    }
    return Object.freeze({
      source: 'linux_procfs',
      sampledAt: sampledAt.toISOString(),
      rootPid,
      processCount: tree.length,
      cpuPercent,
      memoryBytes: tree.reduce((sum, process) => sum + process.residentPages, 0) * 4096,
      diskBytes,
    })
  }
}
