import assert from 'node:assert/strict'
import test from 'node:test'
import { TTYLinuxProcessTelemetryCollector, parseLinuxProcStat } from '../../lib/tty/tty-process-telemetry'

test('linux proc stat parsing keeps command names with spaces aligned', () => {
  const parsed = parseLinuxProcStat('123 (bash worker) S 100 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0')
  assert.deepEqual(parsed, { pid: 123, parentPid: 100, totalCpuTicks: 20, residentPages: 0 })
})

test('process telemetry fails closed on non-Linux hosts', async () => {
  const sample = await new TTYLinuxProcessTelemetryCollector().sample(1, process.cwd())
  if (process.platform === 'linux') return
  assert.equal(sample, null)
})
