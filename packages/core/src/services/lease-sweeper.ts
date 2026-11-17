import { forEachWorkspace } from "./index"
import { sweepExpiredLeases, type SweepResult } from "./retry"

/**
 * Periodic in-process lease sweeper: every interval it recovers items whose
 * lease expired (dead agents) via `sweepExpiredLeases` — under the storage
 * write lock, with history (actor `system:lease-sweeper`) and domain events.
 *
 * One instance per process: the running sweeper lives on `globalThis`, so dev
 * hot reloads (which re-evaluate this module) replace it instead of stacking
 * timers. Started from `instrumentation.ts` at server boot (never during
 * `next build`). Configure with `MCPOCKET_SWEEPER_ENABLED` /
 * `MCPOCKET_SWEEPER_INTERVAL_SECONDS`.
 */

export type SweeperConfig = { enabled: boolean; intervalSeconds: number }

export const DEFAULT_SWEEPER_INTERVAL_SECONDS = 15
export const MAX_SWEEPER_INTERVAL_SECONDS = 3600

const FALSY = new Set(["0", "false", "off", "no", "disabled"])
const TRUTHY = new Set(["1", "true", "on", "yes", "enabled"])

/** `MCPOCKET_SWEEPER_ENABLED` (default true), `MCPOCKET_SWEEPER_INTERVAL_SECONDS` (15, 1..3600). */
export function sweeperConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): SweeperConfig {
  const enabledRaw = env.MCPOCKET_SWEEPER_ENABLED?.trim().toLowerCase()
  if (enabledRaw && !FALSY.has(enabledRaw) && !TRUTHY.has(enabledRaw)) {
    throw new Error(
      `Invalid MCPOCKET_SWEEPER_ENABLED "${enabledRaw}" (true | false)`
    )
  }
  const intervalRaw = env.MCPOCKET_SWEEPER_INTERVAL_SECONDS?.trim()
  let intervalSeconds = DEFAULT_SWEEPER_INTERVAL_SECONDS
  if (intervalRaw) {
    const n = Number(intervalRaw)
    if (!Number.isInteger(n) || n < 1 || n > MAX_SWEEPER_INTERVAL_SECONDS) {
      throw new Error(
        `Invalid MCPOCKET_SWEEPER_INTERVAL_SECONDS "${intervalRaw}" (integer 1..${MAX_SWEEPER_INTERVAL_SECONDS})`
      )
    }
    intervalSeconds = n
  }
  return { enabled: !enabledRaw || TRUTHY.has(enabledRaw), intervalSeconds }
}

export type Sweeper = {
  /** Runs one pass now (skipped → `null` if a pass is still running). */
  tick: () => Promise<SweepResult | null>
  stop: () => void
  readonly intervalMs: number
}

type Timers = {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

const nodeTimers: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    handle.unref?.() // never keeps the process alive
    return handle
  },
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
}

/**
 * A sweeper calling `sweep` every `intervalMs`. Passes never overlap; errors
 * are reported to `onError` and the next pass runs as usual.
 */
export function createSweeper({
  intervalMs,
  sweep,
  onError = (error) => console.error("[mcpocket] lease sweep failed:", error),
  onSweep,
  timers = nodeTimers,
}: {
  intervalMs: number
  sweep: () => Promise<SweepResult>
  onError?: (error: unknown) => void
  onSweep?: (result: SweepResult) => void
  timers?: Timers
}): Sweeper {
  let running: Promise<SweepResult | null> | null = null
  const tick = (): Promise<SweepResult | null> => {
    if (running) return Promise.resolve(null)
    running = sweep()
      .then((result) => {
        onSweep?.(result)
        return result
      })
      .catch((error: unknown) => {
        onError(error)
        return null
      })
      .finally(() => {
        running = null
      })
    return running
  }
  const handle = timers.setInterval(() => void tick(), intervalMs)
  return { tick, stop: () => timers.clearInterval(handle), intervalMs }
}

const GLOBAL_KEY = Symbol.for("mcpocket.leaseSweeper")
type GlobalWithSweeper = typeof globalThis & { [GLOBAL_KEY]?: Sweeper }

/** The process-wide sweeper, if running. */
export function getLeaseSweeper(): Sweeper | undefined {
  return (globalThis as GlobalWithSweeper)[GLOBAL_KEY]
}

/** Stops and forgets the process-wide sweeper (tests, shutdown). */
export function stopLeaseSweeper(): void {
  const g = globalThis as GlobalWithSweeper
  g[GLOBAL_KEY]?.stop()
  delete g[GLOBAL_KEY]
}

/**
 * Starts the process-wide sweeper from env config (returns `null` when
 * disabled). Calling it again replaces the running instance — there is
 * never more than one timer per process.
 */
export function startLeaseSweeper(
  env: Record<string, string | undefined> = process.env
): Sweeper | null {
  stopLeaseSweeper()
  const config = sweeperConfigFromEnv(env)
  if (!config.enabled) return null
  const sweeper = createSweeper({
    intervalMs: config.intervalSeconds * 1000,
    // Every workspace with items (multi-workspace mode), one after another.
    sweep: async () => {
      const results = await forEachWorkspace("items", sweepExpiredLeases)
      return {
        requeued: results.reduce((n, r) => n + r.requeued, 0),
        failed: results.reduce((n, r) => n + r.failed, 0),
        items: results.flatMap((r) => r.items),
      }
    },
    onSweep: ({ requeued, failed }) => {
      if (requeued + failed > 0) {
        console.info(
          `[mcpocket] lease sweeper: ${requeued} item(s) requeued for retry, ${failed} failed (attempts exhausted)`
        )
      }
    },
  })
  ;(globalThis as GlobalWithSweeper)[GLOBAL_KEY] = sweeper
  return sweeper
}
