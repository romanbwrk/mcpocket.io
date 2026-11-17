import type { RateLimitInfo } from "../domain/errors"

/**
 * In-memory fixed-window rate limiter (v1 is single-process). Used per API
 * key for REST and MCP (all HTTP transports) and per client for dashboard
 * logins. Windows live on `globalThis` so every route bundle and dev hot
 * reloads share them.
 */
export type RateLimitResult = RateLimitInfo & { allowed: boolean }

type Window = { start: number; count: number }

/** Entries kept before expired windows are pruned. */
const PRUNE_THRESHOLD = 10_000

export class RateLimiter {
  private readonly windows = new Map<string, Window>()

  constructor(readonly windowMs: number) {}

  private current(key: string, now: number): Window {
    let window = this.windows.get(key)
    if (!window || now - window.start >= this.windowMs) {
      if (this.windows.size >= PRUNE_THRESHOLD) this.prune(now)
      window = { start: now, count: 0 }
      this.windows.set(key, window)
    }
    return window
  }

  private result(window: Window, limit: number, now: number, allowed: boolean) {
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - window.count),
      resetSeconds: Math.max(
        1,
        Math.ceil((window.start + this.windowMs - now) / 1000)
      ),
    }
  }

  /** Counts one request; `allowed: false` once `limit` is exceeded in the window. */
  consume(key: string, limit: number, now = Date.now()): RateLimitResult {
    const window = this.current(key, now)
    if (window.count >= limit) return this.result(window, limit, now, false)
    window.count++
    return this.result(window, limit, now, true)
  }

  /** State without counting (e.g. "may this client still try to log in?"). */
  peek(key: string, limit: number, now = Date.now()): RateLimitResult {
    const window = this.current(key, now)
    return this.result(window, limit, now, window.count < limit)
  }

  reset(key?: string): void {
    if (key === undefined) this.windows.clear()
    else this.windows.delete(key)
  }

  private prune(now: number) {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key)
    }
  }
}

const globalKey = Symbol.for("mcpocket.rateLimiters")
type GlobalWithLimiters = typeof globalThis & {
  [globalKey]?: Map<string, RateLimiter>
}

/** Named process-wide limiter (created on first use with `windowMs`). */
export function getRateLimiter(name: string, windowMs: number): RateLimiter {
  const g = globalThis as GlobalWithLimiters
  const limiters = (g[globalKey] ??= new Map())
  let limiter = limiters.get(name)
  if (!limiter || limiter.windowMs !== windowMs) {
    limiter = new RateLimiter(windowMs)
    limiters.set(name, limiter)
  }
  return limiter
}

/** Test helper: forgets every limiter's state. */
export function resetRateLimiters(): void {
  ;(globalThis as GlobalWithLimiters)[globalKey]?.clear()
}

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 600

function intFromEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number
): number {
  const value = raw?.trim()
  if (!value) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`Invalid ${name} "${value}" (integer ≥ ${min})`)
  }
  return n
}

/** `MCPOCKET_RATE_LIMIT_PER_MINUTE`: requests per API key per minute (default 600, 0 = off). */
export function rateLimitPerMinuteFromEnv(
  env: Record<string, string | undefined> = process.env
): number {
  return intFromEnv(
    "MCPOCKET_RATE_LIMIT_PER_MINUTE",
    env.MCPOCKET_RATE_LIMIT_PER_MINUTE,
    DEFAULT_RATE_LIMIT_PER_MINUTE,
    0
  )
}

export type LoginRateLimitConfig = { attempts: number; windowSeconds: number }

/**
 * Failed dashboard logins allowed per client (IP) and window:
 * `MCPOCKET_LOGIN_MAX_ATTEMPTS` (default 10, 0 = off) per
 * `MCPOCKET_LOGIN_WINDOW_SECONDS` (default 900).
 */
export function loginRateLimitFromEnv(
  env: Record<string, string | undefined> = process.env
): LoginRateLimitConfig {
  return {
    attempts: intFromEnv(
      "MCPOCKET_LOGIN_MAX_ATTEMPTS",
      env.MCPOCKET_LOGIN_MAX_ATTEMPTS,
      10,
      0
    ),
    windowSeconds: intFromEnv(
      "MCPOCKET_LOGIN_WINDOW_SECONDS",
      env.MCPOCKET_LOGIN_WINDOW_SECONDS,
      900,
      1
    ),
  }
}

/** `RateLimit-*` response headers (IETF draft), plus `Retry-After` when limited. */
export function rateLimitHeaders(
  info: RateLimitInfo,
  limited = false
): Record<string, string> {
  return {
    "RateLimit-Limit": String(info.limit),
    "RateLimit-Remaining": String(info.remaining),
    "RateLimit-Reset": String(info.resetSeconds),
    ...(limited && { "Retry-After": String(info.resetSeconds) }),
  }
}

/** Copies rate-limit headers onto a response (new Response if headers are immutable). */
export function withRateLimitHeaders(
  response: Response,
  info: RateLimitInfo | null
): Response {
  if (!info) return response
  const headers = rateLimitHeaders(info)
  try {
    for (const [k, v] of Object.entries(headers)) response.headers.set(k, v)
    return response
  } catch {
    const copy = new Response(response.body, response)
    for (const [k, v] of Object.entries(headers)) copy.headers.set(k, v)
    return copy
  }
}
