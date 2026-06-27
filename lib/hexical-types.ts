export type MessageRole = 'user' | 'hexical' | 'error'

export type RoutePath = 'local' | 'global' | 'math' | 'unknown'

export interface StreamMessage {
  id: string
  role: MessageRole
  text: string
  steps?: string[]
  valid?: boolean
  route?: RoutePath
  ts: string
}

export interface VerifyResponse {
  analysis: string
  steps: string[]
  valid: boolean
}

/**
 * Infer which part of the engine handled the request from the routing steps.
 * Used to drive the telemetry highlight in the right sidebar.
 */
export function inferRoute(steps: string[] = []): RoutePath {
  const blob = steps.join(' ').toLowerCase()
  if (/groq|global|cloud|remote/.test(blob)) return 'global'
  if (/math|calc|solver|equation|compute/.test(blob)) return 'math'
  if (/local|k-?12|database|offline|cache/.test(blob)) return 'local'
  return 'unknown'
}

export const HEX_ENDPOINT = 'http://localhost:8000/verify'
