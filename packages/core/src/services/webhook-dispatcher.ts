import type {
  WebhookAttempt,
  WebhookDelivery,
  Webhook,
} from "../domain/schemas"
import { getEventBus, type EventBus } from "../events/bus"
import { SIGNATURE_HEADER, signWebhookPayload } from "../webhooks/signature"

import type { ServiceContext } from "./context"
import { forEachWorkspace } from "./index"

/**
 * Webhook delivery worker (ticket 17): reads due rows from the transactional
 * outbox (`webhookDeliveries`, status `pending`, `nextAttemptAt <= now`),
 * POSTs the signed payload and records the attempt:
 *
 * - 2xx → `delivered`;
 * - anything else (non-2xx, redirect, network error, timeout) → retried with
 *   exponential backoff, `dead` (dead-lettered) after `maxAttempts`.
 *
 * At-least-once: a row is only marked after the HTTP response, so a crash
 * mid-send re-sends it after restart (rows live in data/webhook-deliveries.json).
 * Consumers dedupe on the `X-MCPocket-Delivery` header / payload `id`.
 * Deliveries of disabled subscriptions stay pending until re-enabled.
 *
 * One worker per process (globalThis singleton, like the lease sweeper),
 * started from instrumentation.ts; passes never overlap. The event bus only
 * nudges it to run early — correctness never depends on the bus.
 */

export type WebhookDispatchConfig = {
  enabled: boolean
  intervalSeconds: number
  maxAttempts: number
  backoffSeconds: number
  maxBackoffSeconds: number
  timeoutSeconds: number
  /** Delivered / dead rows older than this are pruned; 0 keeps them forever. */
  retentionDays: number
  /** Max deliveries sent concurrently per pass. */
  batchSize: number
}

export const DEFAULT_WEBHOOK_CONFIG: WebhookDispatchConfig = {
  enabled: true,
  intervalSeconds: 5,
  maxAttempts: 8,
  backoffSeconds: 10,
  maxBackoffSeconds: 3600,
  timeoutSeconds: 10,
  retentionDays: 7,
  batchSize: 20,
}

/** Attempts kept per delivery row (older ones are dropped). */
export const MAX_ATTEMPT_LOG = 20
const MAX_TEXT = 500

const FALSY = new Set(["0", "false", "off", "no", "disabled"])
const TRUTHY = new Set(["1", "true", "on", "yes", "enabled"])

type Env = Record<string, string | undefined>

function intFromEnv(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name} "${raw}" (integer ${min}..${max})`)
  }
  return n
}

/**
 * `MCPOCKET_WEBHOOKS_ENABLED` (true), `MCPOCKET_WEBHOOK_INTERVAL_SECONDS` (5),
 * `MCPOCKET_WEBHOOK_MAX_ATTEMPTS` (8), `MCPOCKET_WEBHOOK_BACKOFF_SECONDS` (10),
 * `MCPOCKET_WEBHOOK_MAX_BACKOFF_SECONDS` (3600),
 * `MCPOCKET_WEBHOOK_TIMEOUT_SECONDS` (10), `MCPOCKET_WEBHOOK_RETENTION_DAYS`
 * (7, 0 = forever), `MCPOCKET_WEBHOOK_BATCH_SIZE` (20).
 */
export function webhookConfigFromEnv(
  env: Env = process.env
): WebhookDispatchConfig {
  const d = DEFAULT_WEBHOOK_CONFIG
  const enabledRaw = env.MCPOCKET_WEBHOOKS_ENABLED?.trim().toLowerCase()
  if (enabledRaw && !FALSY.has(enabledRaw) && !TRUTHY.has(enabledRaw)) {
    throw new Error(
      `Invalid MCPOCKET_WEBHOOKS_ENABLED "${enabledRaw}" (true | false)`
    )
  }
  const backoffSeconds = intFromEnv(
    env,
    "MCPOCKET_WEBHOOK_BACKOFF_SECONDS",
    d.backoffSeconds,
    1,
    86_400
  )
  const maxBackoffSeconds = intFromEnv(
    env,
    "MCPOCKET_WEBHOOK_MAX_BACKOFF_SECONDS",
    d.maxBackoffSeconds,
    1,
    7 * 86_400
  )
  if (maxBackoffSeconds < backoffSeconds) {
    throw new Error(
      "MCPOCKET_WEBHOOK_MAX_BACKOFF_SECONDS must be >= MCPOCKET_WEBHOOK_BACKOFF_SECONDS"
    )
  }
  return {
    enabled: !enabledRaw || TRUTHY.has(enabledRaw),
    intervalSeconds: intFromEnv(
      env,
      "MCPOCKET_WEBHOOK_INTERVAL_SECONDS",
      d.intervalSeconds,
      1,
      3600
    ),
    maxAttempts: intFromEnv(
      env,
      "MCPOCKET_WEBHOOK_MAX_ATTEMPTS",
      d.maxAttempts,
      1,
      100
    ),
    backoffSeconds,
    maxBackoffSeconds,
    timeoutSeconds: intFromEnv(
      env,
      "MCPOCKET_WEBHOOK_TIMEOUT_SECONDS",
      d.timeoutSeconds,
      1,
      300
    ),
    retentionDays: intFromEnv(
      env,
      "MCPOCKET_WEBHOOK_RETENTION_DAYS",
      d.retentionDays,
      0,
      3650
    ),
    batchSize: intFromEnv(
      env,
      "MCPOCKET_WEBHOOK_BATCH_SIZE",
      d.batchSize,
      1,
      500
    ),
  }
}

/** Delay before retry number `attempt + 1` after `attempt` failed attempts (1-based). */
export function webhookRetryDelaySeconds(
  attempt: number,
  config: Pick<WebhookDispatchConfig, "backoffSeconds" | "maxBackoffSeconds">
): number {
  const exponent = Math.max(0, attempt - 1)
  return Math.min(
    config.backoffSeconds * 2 ** Math.min(exponent, 30),
    config.maxBackoffSeconds
  )
}

export type DispatchResult = {
  attempted: number
  delivered: number
  retrying: number
  dead: number
  pruned: number
  /** True when more due deliveries were left for the next pass. */
  more: boolean
}

export type FetchLike = (
  url: string,
  init: RequestInit
) => Promise<Pick<Response, "status" | "text">>

export type DispatchOptions = {
  config?: WebhookDispatchConfig
  fetch?: FetchLike
}

const truncate = (text: string) =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "Timed out"
    const cause = (error as { cause?: unknown }).cause
    const detail =
      cause instanceof Error && cause.message ? `: ${cause.message}` : ""
    return truncate(`${error.message}${detail}`)
  }
  return truncate(String(error))
}

/** POSTs one delivery; never throws. */
async function send(
  ctx: ServiceContext,
  webhook: Webhook,
  delivery: WebhookDelivery,
  config: WebhookDispatchConfig,
  fetchImpl: FetchLike
): Promise<WebhookAttempt> {
  const startedAt = ctx.clock.now()
  const started = performance.now()
  const body = JSON.stringify(delivery.payload)
  const timestamp = Math.floor(startedAt.getTime() / 1000)
  const attempt = delivery.attempts + 1
  const base = {
    at: startedAt.toISOString(),
    durationMs: 0,
  }
  try {
    const response = await fetchImpl(webhook.url, {
      method: "POST",
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
      headers: {
        "content-type": "application/json",
        "user-agent": "MCPocket-Webhooks/1",
        "x-mcpocket-event": delivery.eventType,
        "x-mcpocket-event-id": delivery.eventId,
        "x-mcpocket-delivery": delivery.id,
        "x-mcpocket-webhook-id": webhook.id,
        "x-mcpocket-attempt": String(attempt),
        [SIGNATURE_HEADER]: signWebhookPayload(webhook.secret, body, timestamp),
      },
    })
    let text: string | null = null
    try {
      text = truncate(await response.text())
    } catch {
      text = null
    }
    const ok = response.status >= 200 && response.status < 300
    return {
      ...base,
      durationMs: Math.round(performance.now() - started),
      statusCode: response.status,
      ok,
      error: ok ? null : `HTTP ${response.status}`,
      responseBody: text,
    }
  } catch (error) {
    return {
      ...base,
      durationMs: Math.round(performance.now() - started),
      statusCode: null,
      ok: false,
      error: errorMessage(error),
      responseBody: null,
    }
  }
}

/** Records an attempt on the row (re-read under the write lock). */
async function record(
  ctx: ServiceContext,
  deliveryId: string,
  attempt: WebhookAttempt,
  config: WebhookDispatchConfig
): Promise<WebhookDelivery["status"] | null> {
  return ctx.storage.transaction(async (repos) => {
    const current = await repos.webhookDeliveries.get(deliveryId)
    if (!current) return null // webhook deleted meanwhile
    const attempts = current.attempts + 1
    const nowDate = ctx.clock.now()
    const now = nowDate.toISOString()
    const attemptLog = [...current.attemptLog, attempt].slice(-MAX_ATTEMPT_LOG)
    if (attempt.ok) {
      await repos.webhookDeliveries.update(deliveryId, {
        status: "delivered",
        attempts,
        attemptLog,
        lastAttemptAt: attempt.at,
        deliveredAt: now,
        nextAttemptAt: null,
        lastError: null,
        updatedAt: now,
      })
      return "delivered"
    }
    const dead = attempts >= config.maxAttempts
    const nextAttemptAt = dead
      ? null
      : new Date(
          nowDate.getTime() + webhookRetryDelaySeconds(attempts, config) * 1000
        ).toISOString()
    await repos.webhookDeliveries.update(deliveryId, {
      status: dead ? "dead" : "pending",
      attempts,
      attemptLog,
      lastAttemptAt: attempt.at,
      nextAttemptAt,
      lastError: attempt.error,
      updatedAt: now,
    })
    return dead ? "dead" : "pending"
  })
}

/** Deletes delivered / dead rows not touched for `retentionDays`. */
async function prune(
  ctx: ServiceContext,
  config: WebhookDispatchConfig
): Promise<number> {
  if (config.retentionDays <= 0) return 0
  const cutoff = ctx.clock.now().getTime() - config.retentionDays * 86_400_000
  const old = (
    await ctx.storage.webhookDeliveries.list({ status: ["delivered", "dead"] })
  ).filter((d) => Date.parse(d.updatedAt) < cutoff)
  if (old.length === 0) return 0
  return ctx.storage.transaction(async (repos) => {
    let removed = 0
    for (const d of old) {
      if (await repos.webhookDeliveries.delete(d.id)) removed++
    }
    return removed
  })
}

/**
 * One dispatcher pass: sends up to `batchSize` due deliveries concurrently
 * and records each outcome, then prunes old finished rows.
 */
export async function dispatchWebhooks(
  ctx: ServiceContext,
  {
    config = webhookConfigFromEnv(),
    fetch: fetchImpl = fetch,
  }: DispatchOptions = {}
): Promise<DispatchResult> {
  const result: DispatchResult = {
    attempted: 0,
    delivered: 0,
    retrying: 0,
    dead: 0,
    pruned: 0,
    more: false,
  }
  const webhooks = new Map(
    (await ctx.storage.webhooks.list()).map((w) => [w.id, w])
  )
  const due = (
    await ctx.storage.webhookDeliveries.list({
      status: "pending",
      dueBefore: ctx.clock.now().toISOString(),
    })
  )
    .filter((d) => webhooks.get(d.webhookId)?.enabled)
    .sort(
      (a, b) =>
        Date.parse(a.nextAttemptAt!) - Date.parse(b.nextAttemptAt!) ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt)
    )
  const batch = due.slice(0, config.batchSize)
  result.more = due.length > batch.length

  await Promise.all(
    batch.map(async (delivery) => {
      const attempt = await send(
        ctx,
        webhooks.get(delivery.webhookId)!,
        delivery,
        config,
        fetchImpl
      )
      const status = await record(ctx, delivery.id, attempt, config)
      if (status === null) return
      result.attempted++
      if (status === "delivered") result.delivered++
      else if (status === "dead") result.dead++
      else result.retrying++
    })
  )
  result.pruned = await prune(ctx, config)
  return result
}

// --- background worker ------------------------------------------------------

export type WebhookDispatcher = {
  /** Runs one pass now (`null` if one is already running — it is re-run after). */
  tick: () => Promise<DispatchResult | null>
  /** Asks for a pass soon (debounced), e.g. after an item event. */
  nudge: () => void
  stop: () => void
  readonly intervalMs: number
}

type Timers = {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const nodeTimers: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    handle.unref?.() // never keeps the process alive
    return handle
  },
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export const NUDGE_DELAY_MS = 100

/**
 * Runs `dispatch` every `intervalMs` and shortly after nudges (item events
 * on `bus`). Passes never overlap; a nudge during a pass, or a pass that left
 * due work behind, triggers a follow-up pass.
 */
export function createWebhookDispatcher({
  intervalMs,
  dispatch,
  bus,
  onError = (error) =>
    console.error("[mcpocket] webhook dispatch failed:", error),
  onDispatch,
  timers = nodeTimers,
}: {
  intervalMs: number
  dispatch: () => Promise<DispatchResult>
  bus?: EventBus
  onError?: (error: unknown) => void
  onDispatch?: (result: DispatchResult) => void
  timers?: Timers
}): WebhookDispatcher {
  let running: Promise<DispatchResult | null> | null = null
  let rerun = false
  let stopped = false
  let nudgeHandle: unknown = null

  const nudge = () => {
    if (stopped) return
    if (running) {
      rerun = true
      return
    }
    if (nudgeHandle !== null) return
    nudgeHandle = timers.setTimeout(() => {
      nudgeHandle = null
      void tick()
    }, NUDGE_DELAY_MS)
  }

  const tick = (): Promise<DispatchResult | null> => {
    if (running) {
      rerun = true
      return Promise.resolve(null)
    }
    rerun = false
    running = dispatch()
      .then((result) => {
        onDispatch?.(result)
        if (result.more) rerun = true
        return result
      })
      .catch((error: unknown) => {
        onError(error)
        return null
      })
      .finally(() => {
        running = null
        if (rerun) nudge()
      })
    return running
  }

  const handle = timers.setInterval(() => void tick(), intervalMs)
  const unsubscribe = bus?.subscribe((event) => {
    if (event.type.startsWith("item.")) nudge()
  })

  return {
    tick,
    nudge,
    stop: () => {
      stopped = true
      timers.clearInterval(handle)
      if (nudgeHandle !== null) timers.clearTimeout(nudgeHandle)
      unsubscribe?.()
    },
    intervalMs,
  }
}

const GLOBAL_KEY = Symbol.for("mcpocket.webhookDispatcher")
type GlobalWithDispatcher = typeof globalThis & {
  [GLOBAL_KEY]?: WebhookDispatcher
}

/** The process-wide dispatcher, if running. */
export function getWebhookDispatcher(): WebhookDispatcher | undefined {
  return (globalThis as GlobalWithDispatcher)[GLOBAL_KEY]
}

/** Stops and forgets the process-wide dispatcher (tests, shutdown). */
export function stopWebhookDispatcher(): void {
  const g = globalThis as GlobalWithDispatcher
  g[GLOBAL_KEY]?.stop()
  delete g[GLOBAL_KEY]
}

/**
 * Starts the process-wide dispatcher from env config (`null` when
 * `MCPOCKET_WEBHOOKS_ENABLED=false`; outbox rows are still written and wait).
 * Calling it again replaces the running instance — one per process.
 */
export function startWebhookDispatcher(
  env: Env = process.env
): WebhookDispatcher | null {
  stopWebhookDispatcher()
  const config = webhookConfigFromEnv(env)
  if (!config.enabled) return null
  const dispatcher = createWebhookDispatcher({
    intervalMs: config.intervalSeconds * 1000,
    bus: getEventBus(),
    // Every workspace with deliveries (multi-workspace mode), one after another.
    dispatch: async () => {
      const results = await forEachWorkspace("webhookDeliveries", (ctx) =>
        dispatchWebhooks(ctx, { config })
      )
      const sum = (key: Exclude<keyof DispatchResult, "more">) =>
        results.reduce((n, r) => n + r[key], 0)
      return {
        attempted: sum("attempted"),
        delivered: sum("delivered"),
        retrying: sum("retrying"),
        dead: sum("dead"),
        pruned: sum("pruned"),
        more: results.some((r) => r.more),
      }
    },
    onDispatch: ({ delivered, retrying, dead }) => {
      if (retrying + dead > 0) {
        console.warn(
          `[mcpocket] webhooks: ${delivered} delivered, ${retrying} failed (will retry), ${dead} dead-lettered`
        )
      }
    },
  })
  ;(globalThis as GlobalWithDispatcher)[GLOBAL_KEY] = dispatcher
  dispatcher.nudge() // deliver what was left in the outbox before the restart
  return dispatcher
}
