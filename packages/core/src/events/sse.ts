import type { EventBus } from "./bus"
import {
  matchesEventScope,
  SSE_DOMAIN_EVENT,
  SSE_READY_EVENT,
  type DomainEvent,
  type EventScope,
} from "./types"

export const SSE_KEEP_ALIVE_MS = 15_000
/** Client reconnect delay advertised via the SSE `retry:` field. */
export const SSE_RETRY_MS = 3_000

export type EventStreamOptions = {
  bus: EventBus
  scope: EventScope
  /** Only events of this workspace (multi-workspace mode); unset = all. */
  workspace?: string
  /** Request abort signal: closes the stream and unsubscribes. */
  signal?: AbortSignal
  keepAliveMs?: number
}

const encoder = new TextEncoder()

export function formatSseEvent(event: DomainEvent): string {
  return `id: ${event.seq}\nevent: ${SSE_DOMAIN_EVENT}\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * `text/event-stream` response relaying bus events matching `scope`.
 * Sends `retry:` + a `ready` event first, a `: ping` comment every
 * `keepAliveMs`, and releases its bus listener and timer as soon as the
 * client disconnects (stream cancel or request abort) — no leaked listeners.
 */
export function createEventStreamResponse({
  bus,
  scope,
  workspace,
  signal,
  keepAliveMs = SSE_KEEP_ALIVE_MS,
}: EventStreamOptions): Response {
  let cleanup = () => {}

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const write = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup() // controller already closed underneath us
        }
      }

      const unsubscribe = bus.subscribe((event) => {
        if (workspace !== undefined && event.workspace !== workspace) return
        if (matchesEventScope(event, scope)) write(formatSseEvent(event))
      })
      const timer = setInterval(() => write(": ping\n\n"), keepAliveMs)
      const onAbort = () => {
        cleanup()
        try {
          controller.close()
        } catch {
          // already closed / cancelled
        }
      }

      cleanup = () => {
        if (closed) return
        closed = true
        unsubscribe()
        clearInterval(timer)
        signal?.removeEventListener("abort", onAbort)
      }

      if (signal?.aborted) return onAbort()
      signal?.addEventListener("abort", onAbort, { once: true })

      write(`retry: ${SSE_RETRY_MS}\n`)
      write(
        `event: ${SSE_READY_EVENT}\ndata: ${JSON.stringify({ scope, seq: bus.lastSeq })}\n\n`
      )
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // nginx / proxies: don't buffer the stream
    },
  })
}
