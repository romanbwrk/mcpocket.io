import {
  BACKOFF_STRATEGIES,
  MAX_RETRY_ATTEMPTS,
  MAX_RETRY_DELAY_SECONDS,
  type BackoffStrategy,
  type RetryPolicy,
} from "@mcpocket/core/domain/retry-policy"
import { MAX_LEASE_SECONDS } from "@mcpocket/core/domain/schemas"

export type SchemaTextResult =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; error: string }

/** Textarea JSON → schema object, `null` (empty = no schema) or a parse error. */
export function parseSchemaText(text: string): SchemaTextResult {
  if (!text.trim()) return { ok: true, value: null }
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "The schema must be a JSON object" }
    }
    return { ok: true, value: value as Record<string, unknown> }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON",
    }
  }
}

export type LeaseSecondsResult =
  { ok: true; value: number | null } | { ok: false; error: string }

/** Lease field → seconds, `null` (empty = server default) or an error. */
export function parseLeaseSeconds(text: string): LeaseSecondsResult {
  const raw = text.trim()
  if (!raw) return { ok: true, value: null }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_LEASE_SECONDS) {
    return {
      ok: false,
      error: `Whole seconds between 1 and ${MAX_LEASE_SECONDS}`,
    }
  }
  return { ok: true, value: n }
}

export type RetryPolicyFields = {
  maxAttempts: string
  backoff: string
  delaySeconds: string
  maxDelaySeconds: string
}

export type RetryPolicyFieldsResult =
  | { ok: true; value: RetryPolicy | null }
  | { ok: false; errors: Partial<Record<keyof RetryPolicyFields, string>> }

/** Tube's stored overrides → form strings (empty = use the server default). */
export function retryPolicyFields(
  policy: RetryPolicy | null | undefined
): RetryPolicyFields {
  const str = (v: number | undefined) => (v === undefined ? "" : String(v))
  return {
    maxAttempts: str(policy?.maxAttempts),
    backoff: policy?.backoff ?? "",
    delaySeconds: str(policy?.delaySeconds),
    maxDelaySeconds: str(policy?.maxDelaySeconds),
  }
}

/**
 * Form strings → retry overrides; empty fields are left out (server default),
 * all empty → `null` (no overrides). Bounds match `RetryPolicyInputSchema`.
 */
export function parseRetryPolicyFields(
  fields: RetryPolicyFields
): RetryPolicyFieldsResult {
  const errors: Partial<Record<keyof RetryPolicyFields, string>> = {}
  const policy: RetryPolicy = {}
  const int = (
    key: "maxAttempts" | "delaySeconds" | "maxDelaySeconds",
    min: number,
    max: number
  ) => {
    const raw = fields[key].trim()
    if (!raw) return
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min || n > max) {
      errors[key] = `Whole number ${min}–${max}`
      return
    }
    policy[key] = n
  }
  int("maxAttempts", 1, MAX_RETRY_ATTEMPTS)
  int("delaySeconds", 0, MAX_RETRY_DELAY_SECONDS)
  int("maxDelaySeconds", 0, MAX_RETRY_DELAY_SECONDS)
  const backoff = fields.backoff.trim()
  if (backoff) {
    if ((BACKOFF_STRATEGIES as readonly string[]).includes(backoff)) {
      policy.backoff = backoff as BackoffStrategy
    } else {
      errors.backoff = `One of ${BACKOFF_STRATEGIES.join(", ")}`
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, value: Object.keys(policy).length > 0 ? policy : null }
}
