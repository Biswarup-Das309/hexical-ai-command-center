/**
 * ============================================================================
 * Hexical AI
 * impact.ts
 * ----------------------------------------------------------------------------
 * Impact Prediction Engine (Foundation)
 *
 * PURPOSE
 *  Estimate the downstream impact of a semantic code change.
 * ============================================================================
 */

import { SemanticInsight } from './semantic'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface ImpactArea {
  name: string
  reason: string
}

export interface TestRecommendation {
  name: string
  priority: 'HIGH' | 'MEDIUM' | 'LOW'
  reason: string
}

export interface ImpactReport {
  summary: string
  narrative: string

  breakingChangeProbability: number
  regressionRisk: RiskLevel
  confidence: number

  affectedAreas: ImpactArea[]
  affectedApis: string[]
  affectedModules: string[]
  affectedFiles: string[]

  securityImpact: boolean
  performanceImpact: boolean
  databaseImpact: boolean
  uiImpact: boolean

  recommendations: string[]
  suggestedTests: TestRecommendation[]

  unaffectedAreas: string[]
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function estimateProbability(insight: SemanticInsight): number {
  let score = insight.confidence

  switch (insight.category) {
    case 'AUTHORIZATION':
    case 'AUTHENTICATION':
      score += 18
      break
    case 'SECURITY':
      score += 12
      break
    case 'API':
      score += 10
      break
  }

  return clamp(score, 5, 99)
}

function estimateRisk(probability: number): RiskLevel {
  if (probability >= 90) return 'CRITICAL'
  if (probability >= 70) return 'HIGH'
  if (probability >= 40) return 'MEDIUM'
  return 'LOW'
}

function buildNarrative(insight: SemanticInsight): string {
  return [
    `This change primarily affects ${insight.category.toLowerCase()}.`,
    insight.behaviorChange,
    'Review dependent modules before deployment.',
    'Prioritize the recommended validation scenarios.',
  ].join(' ')
}

export function analyzeImpact(insight: SemanticInsight): ImpactReport {
  const probability = estimateProbability(insight)

  return {
    summary: `${insight.category} change may affect dependent components.`,
    narrative: buildNarrative(insight),

    breakingChangeProbability: probability,
    regressionRisk: estimateRisk(probability),
    confidence: insight.confidence,

    affectedAreas: insight.affectedAreas.map((a) => ({
      name: a,
      reason: 'Referenced by the semantic analysis.',
    })),

    affectedApis: [],
    affectedModules: [],
    affectedFiles: [],

    securityImpact:
      insight.category === 'SECURITY' || insight.category === 'AUTHORIZATION' || insight.category === 'AUTHENTICATION',

    performanceImpact: insight.category === 'CONTROL_FLOW',

    databaseImpact: insight.evidence.some((e) => e.toLowerCase().includes('database')),

    uiImpact: false,

    recommendations: [
      'Review impacted execution paths.',
      'Run targeted regression tests.',
      'Verify downstream integrations.',
    ],

    suggestedTests: insight.suggestedTests.map((t) => ({
      name: t,
      priority: 'HIGH',
      reason: 'Recommended from semantic analysis.',
    })),

    unaffectedAreas: ['Components not referenced by semantic analysis.'],
  }
}

export function analyzeImpactBatch(insights: SemanticInsight[]): ImpactReport[] {
  return insights.map(analyzeImpact)
}
