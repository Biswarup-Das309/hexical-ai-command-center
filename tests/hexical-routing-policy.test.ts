import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseModelRoute } from '@/lib/hexical/routing'
import type { DailySpendState, ExecutionPayload } from '@/lib/hexical/types'

const payload: ExecutionPayload = {
  logic: 'Summarize this harmless test request.',
  profile: 'recon',
  targetArch: 'x64',
  aggressiveness: 'low',
  autoRedact: true,
  workspace: 'runtime-policy-test',
  maxConcurrency: 1,
  contextWindow: 4_096,
  asyncMode: false,
}

function dailySpend(forceCheapModels: boolean): DailySpendState {
  return { budgetPaise: 5_000_00, usedPaise: forceCheapModels ? 5_000_00 : 0, forceCheapModels }
}

test('daily spend guard is an explicit soft routing policy', () => {
  process.env.GROQ_MAIN_MODEL ??= 'test-groq-model'
  process.env.ANTHROPIC_MAIN_MODEL ??= 'test-anthropic-model'
  const guarded = chooseModelRoute({
    tier: 'pro',
    payload,
    promptLogic: payload.logic,
    dailySpend: dailySpend(true),
  })
  assert.equal(guarded.provider, 'groq')
  assert.equal(guarded.reason, 'daily-spend-guard')
  assert.equal(guarded.mode, 'single')

  const normal = chooseModelRoute({
    tier: 'pro',
    payload,
    promptLogic: payload.logic,
    dailySpend: dailySpend(false),
  })
  assert.notEqual(normal.reason, 'daily-spend-guard')
})
