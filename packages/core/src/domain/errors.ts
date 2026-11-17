/**
 * Application errors thrown by services and mapped to transport responses
 * (REST status codes in `lib/api/errors.ts`, MCP tool errors later).
 * Zod `ZodError`s thrown by input validation are mapped to `validation_error`.
 */
export type AppErrorCode =
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "rate_limited"
  | "internal_error"

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly details?: unknown,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = new.target.name
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("validation_error", message, details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Missing or invalid API key") {
    super("unauthorized", message)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", details?: unknown) {
    super("forbidden", message, details)
  }
}

export class NotFoundError extends AppError {
  constructor(
    readonly entity: string,
    readonly id: string
  ) {
    super("not_found", `${entity} "${id}" not found`, { entity, id })
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super("conflict", message, details)
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string, details?: unknown) {
    super("payload_too_large", message, details)
  }
}

/** Rate-limit state reported with a 429 (and as `RateLimit-*` headers). */
export type RateLimitInfo = {
  limit: number
  remaining: number
  /** Seconds until the window resets. */
  resetSeconds: number
}

export class RateLimitedError extends AppError {
  constructor(
    readonly rateLimit: RateLimitInfo,
    message = `Rate limit exceeded: retry in ${rateLimit.resetSeconds} s`
  ) {
    super("rate_limited", message, {
      limit: rateLimit.limit,
      retryAfterSeconds: rateLimit.resetSeconds,
    })
  }
}
