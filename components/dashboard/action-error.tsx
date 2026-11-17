import { CircleAlertIcon } from "lucide-react"

import type { ErrorInfo } from "@mcpocket/core/services/errors"

type Detail = { path?: string; message?: string }

const CODE_LABELS: Partial<Record<ErrorInfo["code"], string>> = {
  validation_error: "Validation failed",
  conflict: "Not allowed",
  not_found: "Not found",
  forbidden: "Forbidden",
}

/** Renders a service error returned by a dashboard server action. */
export function ActionError({ error }: { error: ErrorInfo | null }) {
  if (!error) return null
  const details = Array.isArray(error.details)
    ? (error.details as Detail[]).filter((d) => d && d.message)
    : []
  return (
    <div
      role="alert"
      className="flex gap-2 border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive"
    >
      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">
          {CODE_LABELS[error.code] ?? "Error"}: {error.message}
        </p>
        {details.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4">
            {details.map((d, i) => (
              <li key={i}>
                {d.path ? <code className="font-mono">{d.path}</code> : null}
                {d.path ? ": " : null}
                {d.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
