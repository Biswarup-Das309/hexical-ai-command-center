/** Transport-neutral cancellation service for the live execution coordinator. */

import type { TTYExecutionId } from './tty-types'
import type {
  TTYExecutionCancellationReason,
  TTYExecutionCancellationResult
} from './tty-execution-coordinator'

export interface TTYExecutionCancellationCoordinator {
  cancelExecution(executionId: TTYExecutionId, reason: TTYExecutionCancellationReason): Promise<TTYExecutionCancellationResult>
}

export class TTYCancellationService {
  constructor(private readonly coordinator: TTYExecutionCancellationCoordinator) {}

  cancel(executionId: TTYExecutionId, reason: TTYExecutionCancellationReason = 'user_cancellation'): Promise<TTYExecutionCancellationResult> {
    return this.coordinator.cancelExecution(executionId, reason)
  }
}
