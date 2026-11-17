import { z } from "zod"

/**
 * Retry policy (client-safe: also used by the dashboard settings dialog).
 *
 * A tube may override any field; missing fields fall back to the global
 * defaults (`MCPOCKET_RETRY_*` env vars). `maxAttempts` counts claims: an item
 * whose `attempts` (incremented on every claim) is below `maxAttempts` goes to
 * `retry` when it fails or its lease expires; otherwise it ends up `failed`.
 */

export const BACKOFF_STRATEGIES = ["fixed", "exponential"] as const
export type BackoffStrategy = (typeof BACKOFF_STRATEGIES)[number]

export const MAX_RETRY_ATTEMPTS = 100
export const MAX_RETRY_DELAY_SECONDS = 7 * 86_400

const retryPolicyShape = {
  /** Total attempts (claims) allowed, 1 = never retry. */
  maxAttempts: z.number().int().min(1).max(MAX_RETRY_ATTEMPTS).optional(),
  /** `fixed`: always `delaySeconds`; `exponential`: delay × 2^(attempt−1). */
  backoff: z.enum(BACKOFF_STRATEGIES).optional(),
  /** Base delay before a failed item may be claimed again. */
  delaySeconds: z.number().int().min(0).max(MAX_RETRY_DELAY_SECONDS).optional(),
  /** Upper bound for the exponential delay. */
  maxDelaySeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_RETRY_DELAY_SECONDS)
    .optional(),
}

/** Stored form on `Tube.retryPolicy` (every field optional = use default). */
export const RetryPolicySchema = z.object(retryPolicyShape)
export type RetryPolicy = z.infer<typeof RetryPolicySchema>

/** Input form (REST / MCP / dashboard): strict, unknown keys rejected. */
export const RetryPolicyInputSchema = z.strictObject(retryPolicyShape)

export type ResolvedRetryPolicy = Required<RetryPolicy>

export const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = {
  maxAttempts: 3,
  backoff: "exponential",
  delaySeconds: 30,
  maxDelaySeconds: 3600,
}

/** Tube override (if any) merged over the global defaults. */
export function resolveRetryPolicy(
  policy: RetryPolicy | null | undefined,
  defaults: ResolvedRetryPolicy = DEFAULT_RETRY_POLICY
): ResolvedRetryPolicy {
  return {
    maxAttempts: policy?.maxAttempts ?? defaults.maxAttempts,
    backoff: policy?.backoff ?? defaults.backoff,
    delaySeconds: policy?.delaySeconds ?? defaults.delaySeconds,
    maxDelaySeconds: policy?.maxDelaySeconds ?? defaults.maxDelaySeconds,
  }
}

/** Delay (seconds) after failed attempt number `attempt` (1-based). */
export function retryDelaySeconds(
  policy: ResolvedRetryPolicy,
  attempt: number
): number {
  if (policy.backoff === "fixed") return policy.delaySeconds
  const exponent = Math.max(0, attempt - 1)
  // cap the exponent so huge attempt counts can't overflow to Infinity
  const delay = policy.delaySeconds * 2 ** Math.min(exponent, 40)
  return Math.min(delay, Math.max(policy.maxDelaySeconds, policy.delaySeconds))
}

export type RetryDecision =
  | { retry: true; retryAt: string; delaySeconds: number; maxAttempts: number }
  | { retry: false; maxAttempts: number }

/**
 * What happens after attempt `attempts` failed at `now`: `retry` with a
 * not-before time while attempts remain, otherwise final failure.
 */
export function decideRetry(
  policy: ResolvedRetryPolicy,
  attempts: number,
  now: Date,
  { immediate = false }: { immediate?: boolean } = {}
): RetryDecision {
  if (attempts >= policy.maxAttempts) {
    return { retry: false, maxAttempts: policy.maxAttempts }
  }
  const delaySeconds = immediate ? 0 : retryDelaySeconds(policy, attempts)
  return {
    retry: true,
    retryAt: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
    delaySeconds,
    maxAttempts: policy.maxAttempts,
  }
}

function intFromEnv(
  env: Record<string, string | undefined>,
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
 * Global defaults: `MCPOCKET_RETRY_MAX_ATTEMPTS` (3),
 * `MCPOCKET_RETRY_BACKOFF` (exponential|fixed), `MCPOCKET_RETRY_DELAY_SECONDS`
 * (30), `MCPOCKET_RETRY_MAX_DELAY_SECONDS` (3600). Throws on invalid values.
 */
export function retryDefaultsFromEnv(
  env: Record<string, string | undefined> = process.env
): ResolvedRetryPolicy {
  const backoffRaw = env.MCPOCKET_RETRY_BACKOFF?.trim().toLowerCase()
  if (
    backoffRaw &&
    !(BACKOFF_STRATEGIES as readonly string[]).includes(backoffRaw)
  ) {
    throw new Error(
      `Invalid MCPOCKET_RETRY_BACKOFF "${backoffRaw}" (${BACKOFF_STRATEGIES.join(" | ")})`
    )
  }
  return {
    maxAttempts: intFromEnv(
      env,
      "MCPOCKET_RETRY_MAX_ATTEMPTS",
      DEFAULT_RETRY_POLICY.maxAttempts,
      1,
      MAX_RETRY_ATTEMPTS
    ),
    backoff: (backoffRaw as BackoffStrategy) || DEFAULT_RETRY_POLICY.backoff,
    delaySeconds: intFromEnv(
      env,
      "MCPOCKET_RETRY_DELAY_SECONDS",
      DEFAULT_RETRY_POLICY.delaySeconds,
      0,
      MAX_RETRY_DELAY_SECONDS
    ),
    maxDelaySeconds: intFromEnv(
      env,
      "MCPOCKET_RETRY_MAX_DELAY_SECONDS",
      DEFAULT_RETRY_POLICY.maxDelaySeconds,
      0,
      MAX_RETRY_DELAY_SECONDS
    ),
  }
}
