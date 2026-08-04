import { TTY_RESOURCE_LIMITS, type Tier } from '@/lib/hexical/types'
import type { TTYResourceLimits } from './tty-types'

export function resolveTTYResourceLimits(tier: Tier): TTYResourceLimits | null {
  const configured = TTY_RESOURCE_LIMITS[tier]
  return configured === null ? null : { ...configured }
}
