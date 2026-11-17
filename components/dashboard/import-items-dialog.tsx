"use client"

import { FileUpIcon, UploadIcon } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { bulkPushItemsAction } from "@/app/dashboard/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { chunkImportItems, parseImportText } from "@/lib/dashboard/item-import"
import type { ErrorInfo } from "@mcpocket/core/services/errors"

import { ActionError } from "./action-error"
import { JsonEditor } from "./json-editor"

const PLACEHOLDER = `[
  { "email": "ada@example.com", "name": "Ada" },
  { "payload": { "email": "alan@example.com" }, "priority": 5, "tags": ["vip"] }
]`

/** Failed entries listed in the dialog (the rest are only counted). */
const MAX_LISTED_FAILURES = 20

type Failure = { index: number; error: ErrorInfo }
type Outcome = { succeeded: number; created: number; failures: Failure[] }

/**
 * "Import" button + dialog: paste or load a JSON array of objects (raw
 * payloads or push envelopes, see `lib/dashboard/item-import.ts`) and push
 * them into the tube through the bulk push service, in chunks.
 */
export function ImportItemsDialog({
  tubeId,
  enabled,
}: {
  tubeId: string
  enabled: boolean
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            title={
              enabled
                ? "Add items from JSON"
                : "Disabled tubes reject new items"
            }
          />
        }
      >
        <UploadIcon />
        Import
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        {open && (
          <ImportForm
            tubeId={tubeId}
            enabled={enabled}
            close={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ImportForm({
  tubeId,
  enabled,
  close,
}: {
  tubeId: string
  enabled: boolean
  close: () => void
}) {
  const [text, setText] = React.useState("")
  const [fileName, setFileName] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()
  const [progress, setProgress] = React.useState<string | null>(null)
  const [error, setError] = React.useState<ErrorInfo | null>(null)
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)

  const parsed = React.useMemo(
    () => (text.trim() ? parseImportText(text) : null),
    [text]
  )

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    setText(await file.text())
    setFileName(file.name)
    setOutcome(null)
    setError(null)
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!parsed?.ok) return
    const chunks = chunkImportItems(parsed.items)
    setError(null)
    setOutcome(null)
    startTransition(async () => {
      const result: Outcome = { succeeded: 0, created: 0, failures: [] }
      let offset = 0
      try {
        for (const [i, chunk] of chunks.entries()) {
          if (chunks.length > 1) {
            setProgress(`Importing batch ${i + 1} of ${chunks.length}…`)
          }
          const response = await bulkPushItemsAction(tubeId, { items: chunk })
          if (!response.ok) {
            setError(
              offset > 0
                ? {
                    ...response.error,
                    message: `${response.error.message} (items ${offset + 1}+ not imported)`,
                  }
                : response.error
            )
            break
          }
          for (const r of response.data.results) {
            if (r.ok) {
              result.succeeded++
              if (r.created) result.created++
            } else {
              result.failures.push({ index: offset + r.index, error: r.error })
            }
          }
          offset += chunk.length
        }
      } catch (err) {
        setError({
          code: "internal_error",
          message: err instanceof Error ? err.message : "Request failed",
        })
      }
      setProgress(null)
      if (result.succeeded > 0) {
        const replays = result.succeeded - result.created
        toast.success(
          `Imported ${result.created} item${result.created === 1 ? "" : "s"}` +
            (replays > 0 ? ` (${replays} already existed)` : "")
        )
      }
      if (result.failures.length === 0 && offset === parsed.items.length) {
        close()
      } else {
        setOutcome(result)
      }
    })
  }

  const count = parsed?.ok ? parsed.items.length : 0

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Import items</DialogTitle>
        <DialogDescription>
          Paste a JSON array of objects or load a <code>.json</code> file. Each
          object becomes an item payload; objects shaped like{" "}
          <code>
            {"{ payload, priority?, tags?, metadata?, idempotencyKey? }"}
          </code>{" "}
          are pushed with those fields. You can also paste a plain list of
          values separated by commas or new lines; each becomes{" "}
          <code>{'{ "value": "..." }'}</code>.
        </DialogDescription>
      </DialogHeader>

      {!enabled && (
        <p className="border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-300">
          This tube is disabled and will reject new items. Enable it in Settings
          first.
        </p>
      )}

      <Field data-invalid={(parsed && !parsed.ok) || undefined}>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor="import-json">JSON or list</FieldLabel>
          <div className="flex items-center gap-2">
            {fileName && (
              <span className="max-w-48 truncate text-xs text-muted-foreground">
                {fileName}
              </span>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".json,.jsonl,.ndjson,.txt,.csv,application/json,text/plain"
              className="hidden"
              onChange={onFile}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={pending}
            >
              <FileUpIcon data-icon="inline-start" />
              Choose file
            </Button>
          </div>
        </div>
        <JsonEditor
          id="import-json"
          value={text}
          onChange={(value) => {
            setText(value)
            setFileName(null)
            setOutcome(null)
          }}
          placeholder={PLACEHOLDER}
          invalid={(parsed && !parsed.ok) || undefined}
          readOnly={pending}
          className="[&_textarea]:placeholder:text-muted-foreground"
        />
        {parsed && !parsed.ok ? (
          <FieldError>{parsed.error}</FieldError>
        ) : (
          <FieldDescription>
            {count > 0
              ? `${count} item${count === 1 ? "" : "s"} ready to import.`
              : 'Also accepts { "items": [...] }, a single object, JSON Lines or a comma / newline separated list.'}
          </FieldDescription>
        )}
      </Field>

      <ActionError error={error} />
      {outcome && <ImportOutcome outcome={outcome} />}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          {outcome ? "Close" : "Cancel"}
        </DialogClose>
        <Button type="submit" disabled={pending || !parsed?.ok}>
          {pending
            ? (progress ?? "Importing…")
            : `Import${count > 0 ? ` ${count}` : ""}`}
        </Button>
      </DialogFooter>
    </form>
  )
}

function ImportOutcome({ outcome }: { outcome: Outcome }) {
  const { succeeded, failures } = outcome
  if (failures.length === 0) return null
  const listed = failures.slice(0, MAX_LISTED_FAILURES)
  return (
    <div
      role="alert"
      className="max-h-48 space-y-1 overflow-auto border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive"
    >
      <p className="font-medium">
        {succeeded} imported, {failures.length} failed
      </p>
      <ul className="list-disc space-y-0.5 pl-4">
        {listed.map(({ index, error }) => (
          <li key={index}>
            Entry {index + 1}: {error.message}
            {Array.isArray(error.details) &&
              (error.details as { path?: string; message?: string }[])
                .filter((d) => d?.message)
                .slice(0, 3)
                .map((d, i) => (
                  <span key={i} className="block pl-2 opacity-80">
                    {d.path ? (
                      <code className="font-mono">{d.path}</code>
                    ) : null}
                    {d.path ? ": " : null}
                    {d.message}
                  </span>
                ))}
          </li>
        ))}
      </ul>
      {failures.length > listed.length && (
        <p>…and {failures.length - listed.length} more.</p>
      )}
    </div>
  )
}
