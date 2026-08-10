/**
 * ============================================================================
 * Hexical AI
 * behavior.ts
 * ----------------------------------------------------------------------------
 * Runtime Behavior Analysis Engine (Foundation)
 *
 * PURPOSE
 *   Explain how a code change alters application behavior instead of merely
 *   describing syntax changes.
 * ============================================================================
 */

import { ImpactReport } from './impact'
import { SemanticInsight } from './semantic'

export type BehaviorType =
  | 'EXECUTION_FLOW'
  | 'AUTH_FLOW'
  | 'STATE'
  | 'API'
  | 'ERROR_HANDLING'
  | 'PERFORMANCE'
  | 'DATA_FLOW'
  | 'GENERAL'

export interface BehaviorObservation {
  id: string
  type: BehaviorType
  headline: string
  explanation: string
  before: string
  after: string
  possibleConsequences: string[]
  confidence: number
}

export interface BehaviorReport {
  summary: string
  observations: BehaviorObservation[]
  userImpact: string[]
  developerNotes: string[]
  qaChecklist: string[]
}

function behaviorType(insight: SemanticInsight): BehaviorType {
  switch (insight.category) {
    case 'AUTHENTICATION':
    case 'AUTHORIZATION':
      return 'AUTH_FLOW'
    case 'API':
      return 'API'
    case 'CONTROL_FLOW':
      return 'EXECUTION_FLOW'
    case 'DATA_FLOW':
      return 'DATA_FLOW'
    default:
      return 'GENERAL'
  }
}

function observation(insight: SemanticInsight, impact: ImpactReport): BehaviorObservation {
  const type = behaviorType(insight)

  return {
    id: crypto.randomUUID(),
    type,
    headline: `${type.replace('_', ' ')} behavior changed`,
    explanation: insight.behaviorChange,
    before: 'Previous implementation followed the original execution path.',
    after: 'Execution now follows the updated implementation.',
    possibleConsequences: [impact.summary, 'Review dependent workflows.', 'Validate expected runtime behavior.'],
    confidence: Math.min(insight.confidence, impact.confidence),
  }
}

export function analyzeBehavior(insight: SemanticInsight, impact: ImpactReport): BehaviorReport {
  const obs = observation(insight, impact)

  return {
    summary: `Runtime behavior has changed in the ${insight.category.toLowerCase()} domain.`,
    observations: [obs],
    userImpact: [
      'End-user workflows touching this feature should be validated.',
      'Confirm expected outcomes remain consistent.',
    ],
    developerNotes: [impact.narrative, 'Review execution order and edge cases.'],
    qaChecklist: impact.suggestedTests.map((t) => `Verify: ${t.name}`),
  }
}

export function analyzeBehaviorBatch(insights: SemanticInsight[], impacts: ImpactReport[]): BehaviorReport[] {
  return insights.map((insight, index) => analyzeBehavior(insight, impacts[index]))
}
