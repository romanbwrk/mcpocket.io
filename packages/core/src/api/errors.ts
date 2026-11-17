import { RateLimitedError, type AppErrorCode } from "../domain/errors"
import { normalizeError } from "../services/errors"

import { rateLimitHeaders } from "./rate-limit"

export { normalizeError }

/**
 * Consistent JSON error body for every REST endpoint:
 * `{ "error": { "code": "not_found", "message": "...", "details"?: ... } }`
 */
export type ApiErrorBody = {
  error: { code: AppErrorCode; message: string; details?: unknown }
}

const STATUS: Record<AppErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal_error: 500,
}

export function errorResponse(
  code: AppErrorCode,
  message: string,
  details?: unknown,
  init?: ResponseInit
): Response {
  const body: ApiErrorBody = {
    error: { code, message, ...(details !== undefined && { details }) },
  }
  const headers = new Headers(init?.headers)
  if (code === "unauthorized" && !headers.has("www-authenticate")) {
    headers.set("www-authenticate", 'Bearer realm="mcpocket"')
  }
  return Response.json(body, { ...init, status: STATUS[code], headers })
}

/** Maps any thrown error to a JSON error response (status by error code). */
export function toErrorResponse(error: unknown): Response {
  const { code, message, details } = normalizeError(error)
  return errorResponse(
    code,
    message,
    details,
    error instanceof RateLimitedError
      ? { headers: rateLimitHeaders(error.rateLimit, true) }
      : undefined
  )
}
