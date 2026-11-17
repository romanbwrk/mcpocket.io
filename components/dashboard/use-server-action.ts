"use client"

import * as React from "react"

import type { ActionResult } from "@/lib/dashboard/explorer"
import type { ErrorInfo } from "@mcpocket/core/services/errors"

/** Runs a dashboard server action in a transition and tracks its error. */
export function useServerAction() {
  const [pending, startTransition] = React.useTransition()
  const [error, setError] = React.useState<ErrorInfo | null>(null)
  const run = <T>(
    action: () => Promise<ActionResult<T>>,
    onSuccess: (data: T) => void
  ) => {
    setError(null)
    startTransition(async () => {
      try {
        const result = await action()
        if (result.ok) onSuccess(result.data)
        else setError(result.error)
      } catch (err) {
        // redirect() to /login is handled by Next; anything else is unexpected
        setError({
          code: "internal_error",
          message: err instanceof Error ? err.message : "Request failed",
        })
      }
    })
  }
  return { pending, error, run, setError }
}
