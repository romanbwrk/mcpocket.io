import { ZodError } from "zod"

import { AppError, type AppErrorCode } from "../domain/errors"
import { DuplicateIdError } from "../storage/errors"

/** Transport-neutral error description (REST body `error`, MCP tool error, bulk results). */
export type ErrorInfo = {
  code: AppErrorCode
  message: string
  details?: unknown
}

/**
 * Normalizes any thrown error to `{ code, message, details? }`: Zod →
 * `validation_error` with per-issue details, `AppError` → its code, duplicate
 * id → `conflict`, anything else → `internal_error` with a generic message
 * (details are logged, not returned). Shared by REST, MCP and the per-item
 * results of bulk operations so all report identical error semantics.
 */
export function normalizeError(error: unknown): ErrorInfo {
  if (error instanceof ZodError) {
    return {
      code: "validation_error",
      message: "Request validation failed",
      details: error.issues.map(({ path, message, code }) => ({
        path: path.map(String).join("."),
        message,
        code,
      })),
    }
  }
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined && { details: error.details }),
    }
  }
  if (error instanceof DuplicateIdError) {
    return { code: "conflict", message: error.message }
  }
  console.error("[api] unhandled error", error)
  return { code: "internal_error", message: "Internal server error" }
}

/** Expected per-request failures (validation, not found, conflict, ...), as opposed to bugs/IO errors. */
export function isExpectedError(error: unknown): boolean {
  return error instanceof ZodError || error instanceof AppError
}
