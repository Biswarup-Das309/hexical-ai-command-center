/**
 * ============================================================================
 * Hexical AI
 * semantic.ts
 * ----------------------------------------------------------------------------
 * Semantic Change Intelligence Engine (Foundation)
 *
 * PURPOSE
 *  Convert raw AST diff nodes into human-readable semantic insights.
 *
 * This module intentionally contains NO UI code.
 * ============================================================================
 */

import { randomUUID } from 'node:crypto'
import { ASTDiffNode } from './hexical-types'
import { calculateSeverity, SeverityResult } from './severity'

export type SemanticCategory =
  | 'SECURITY'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'API'
  | 'DATA_FLOW'
  | 'CONTROL_FLOW'
  | 'PERFORMANCE'
  | 'STATE'
  | 'VALIDATION'
  | 'GENERAL'

export interface SemanticInsight {
  id: string
  category: SemanticCategory
  title: string
  summary: string
  behaviorChange: string
  risk: SeverityResult
  confidence: number
  evidence: string[]
  affectedAreas: string[]
  suggestedTests: string[]
}

const CATEGORY_RULES: Array<{
  category: SemanticCategory
  keywords: string[]
}> = [
  { category: 'AUTHENTICATION', keywords: ['login', 'jwt', 'token', 'session', 'oauth'] },
  { category: 'AUTHORIZATION', keywords: ['admin', 'role', 'permission', 'authorize'] },
  { category: 'SECURITY', keywords: ['encrypt', 'crypto', 'secret', 'password'] },
  { category: 'API', keywords: ['fetch', 'axios', 'request', 'response', 'api'] },
  { category: 'CONTROL_FLOW', keywords: ['if', 'switch', 'return', 'throw'] },
  { category: 'VALIDATION', keywords: ['validate', 'schema', 'zod', 'yup'] },
]

/**
 * Splits a path/nodeType string into lowercase tokens, treating both
 * non-alphanumeric characters AND camelCase/PascalCase transitions as
 * boundaries. e.g. "src/auth/LoginForm.tsx" and "IfStatement" both yield a
 * "login"/"if" token respectively.
 *
 * This replaces the previous plain `.includes(keyword)` substring check,
 * which produced real false positives: "if" matches inside "notify",
 * "verify", "modified"; "api" matches inside "capital", "rapid". Matching
 * against whole tokens instead keeps the intended behavior (catching AST
 * node-type names like "IfStatement" via its "if" token, or path segments
 * like "loginForm" via its "login" token) without those collisions.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((t) => t.toLowerCase()),
  )
}

function detectCategory(node: ASTDiffNode): SemanticCategory {
  const haystack = `${node.path ?? ''} ${node.nodeType ?? ''}`
  const tokens = tokenize(haystack)

  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((k) => tokens.has(k))) {
      return rule.category
    }
  }

  return 'GENERAL'
}

function summarizeBehavior(node: ASTDiffNode): string {
  switch (node.operation) {
    case 'INSERT':
      return 'Introduces a new execution path.'
    case 'DELETE':
      return 'Removes existing behavior.'
    case 'UPDATE':
      return 'Modifies existing behavior.'
    case 'MOVE':
      return 'Reorganizes behavior without necessarily changing logic.'
    default:
      return 'Behavior changed.'
  }
}

function suggestTests(category: SemanticCategory): string[] {
  switch (category) {
    case 'AUTHENTICATION':
      return ['Login flow', 'Session refresh', 'Expired token handling']
    case 'AUTHORIZATION':
      return ['Role-based access', 'Privilege escalation checks', 'Protected routes']
    case 'API':
      return ['Endpoint integration', 'Response validation']
    case 'VALIDATION':
      return ['Invalid input', 'Boundary conditions', 'Schema compatibility']
    default:
      return ['Regression tests', 'Unit tests']
  }
}

export function analyzeSemanticChange(node: ASTDiffNode): SemanticInsight {
  if (!node || typeof node !== 'object') {
    throw new TypeError('analyzeSemanticChange requires a valid AST diff node.')
  }

  // Defensive fallbacks: path/nodeType are relied on for category detection,
  // evidence text, and affectedAreas (a string[]). If a malformed node ever
  // arrives with one of these missing at runtime despite the declared type,
  // fall back to a safe string instead of interpolating "undefined" into
  // evidence or putting a literal `undefined` inside a string[].
  const path = typeof node.path === 'string' ? node.path : ''
  const nodeType = typeof node.nodeType === 'string' ? node.nodeType : ''

  const category = detectCategory(node)
  const severity = calculateSeverity(node)

  return {
    id: randomUUID(),
    category,
    title: `${category} change detected`,
    summary: `${node.operation} on ${nodeType || 'unknown node'}`,
    behaviorChange: summarizeBehavior(node),
    risk: severity,
    confidence: severity.confidence,
    evidence: [`Path: ${path || 'unknown'}`, `Operation: ${node.operation}`, `Node: ${nodeType || 'unknown'}`],
    affectedAreas: [path || 'unknown'],
    suggestedTests: suggestTests(category),
  }
}

export function analyzeSemanticBatch(nodes: ASTDiffNode[]): SemanticInsight[] {
  if (!Array.isArray(nodes)) {
    throw new TypeError('analyzeSemanticBatch expects an array of AST diff nodes.')
  }

  return nodes.map((node, index) => {
    try {
      return analyzeSemanticChange(node)
    } catch (error) {
      // Re-throw with the offending node identified rather than either:
      //   (a) letting a bare, context-free stack trace bubble up, or
      //   (b) silently dropping/skipping the node.
      // For a tool whose job is surfacing risky changes for review, (b) is
      // actually the more dangerous failure mode — a node that can't be
      // analyzed (and might be the risky one) would just vanish from the
      // report instead of being flagged.
      const label = typeof node?.path === 'string' && node.path ? ` (path: ${node.path})` : ''
      throw new Error(
        `Semantic analysis failed for node at index ${index}${label}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }
  })
}

export function generateExecutiveSummary(insights: SemanticInsight[]): string {
  if (!insights.length) {
    return 'No semantic changes detected.'
  }

  const critical = insights.filter((i) => i.risk.level === 'CRITICAL').length

  const auth = insights.filter((i) => i.category === 'AUTHENTICATION' || i.category === 'AUTHORIZATION').length

  return [
    `${insights.length} semantic changes detected.`,
    `${critical} critical-risk changes.`,
    `${auth} authentication/authorization related.`,
    'Prioritize review by risk before implementation.',
  ].join(' ')
}
