/** Adapter that observes the frozen durable output-stream API. */

import { TTYOutputStreamManager, type TTYOutputEvent, type TTYOutputEventInput } from './tty-output-stream'
import type { TTYRuntimeStore as Redis } from './tty-runtime-store'
import { TTYStreamBroker } from './tty-stream-broker'

/**
 * The execution coordinator still receives a TTYOutputStreamManager. This
 * subclass preserves that public contract while mirroring each durable event
 * to the browser-safe live broker after Redis persistence succeeds.
 */
export class TTYStreamingOutputStreamManager extends TTYOutputStreamManager {
  private readonly brokerTails = new Map<string, Promise<unknown>>()

  constructor(
    redis: Redis,
    private readonly broker: TTYStreamBroker,
    options: { readonly maxPendingEvents?: number } = {},
  ) {
    super(redis, options)
  }

  override async append(input: TTYOutputEventInput): Promise<TTYOutputEvent> {
    const event = await super.append(input)
    await this.publishInDurableOrder(event)
    return event
  }

  private async publishInDurableOrder(event: TTYOutputEvent): Promise<void> {
    const key = String(event.executionId)
    const previous = this.brokerTails.get(key) ?? Promise.resolve()
    const current = previous.then(
      () => this.broker.publishOutputEvent(event),
      () => this.broker.publishOutputEvent(event),
    )
    this.brokerTails.set(key, current)
    try {
      await current
    } catch {
      // The durable Phase 2.0 output stream remains authoritative. A broker
      // outage must not turn successful execution into a runtime failure.
    } finally {
      if (this.brokerTails.get(key) === current) this.brokerTails.delete(key)
    }
  }
}
