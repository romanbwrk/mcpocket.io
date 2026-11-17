import type { DomainEvent, DomainEventInput } from "./types"

export type EventListener = (event: DomainEvent) => void

/**
 * In-process publish/subscribe for domain events (v1 is single-process).
 * Listeners run synchronously in publish order; a throwing listener is
 * isolated (logged) so one broken subscriber can't break a write path or
 * starve the others. Keep listeners cheap: enqueue, don't await.
 */
export class EventBus {
  private readonly listeners = new Set<EventListener>()
  private seq = 0

  /** Stamps `seq` and delivers to every current listener. */
  publish(input: DomainEventInput): DomainEvent {
    const event = { ...input, seq: ++this.seq } as DomainEvent
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error("[mcpocket] event listener failed", error)
      }
    }
    return event
  }

  /** Returns the unsubscribe function (idempotent). */
  subscribe(listener: EventListener): () => void {
    // Wrap so the same function can subscribe twice and unsubscribe once each.
    const entry: EventListener = (event) => listener(event)
    this.listeners.add(entry)
    return () => {
      this.listeners.delete(entry)
    }
  }

  /** Current subscriber count (tests, diagnostics). */
  get listenerCount(): number {
    return this.listeners.size
  }

  /** Last stamped sequence number. */
  get lastSeq(): number {
    return this.seq
  }
}

/** What services need from a bus: publishing. */
export type EventPublisher = Pick<EventBus, "publish">

/** Publishes through `bus`, stamping every event with `workspace`. */
export function workspacePublisher(
  bus: EventBus,
  workspace: string
): EventPublisher {
  return {
    publish: (input) =>
      bus.publish({ ...input, workspace } as DomainEventInput),
  }
}

const globalKey = Symbol.for("mcpocket.eventBus")
type GlobalWithBus = typeof globalThis & { [globalKey]?: EventBus }

/**
 * Process-wide bus. On `globalThis` so every route bundle, server actions and
 * dev hot reloads share one instance (like the storage singleton).
 */
export function getEventBus(): EventBus {
  const g = globalThis as GlobalWithBus
  return (g[globalKey] ??= new EventBus())
}
