"use client"

import { Settings2Icon } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { updateTubeAction } from "@/app/dashboard/actions"
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
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

import {
  parseLeaseSeconds,
  parseRetryPolicyFields,
  parseSchemaText,
  retryPolicyFields,
  type RetryPolicyFields,
} from "@/lib/dashboard/tube-settings"
import {
  BACKOFF_STRATEGIES,
  type ResolvedRetryPolicy,
  type RetryPolicy,
} from "@mcpocket/core/domain/retry-policy"
import { MAX_LEASE_SECONDS } from "@mcpocket/core/domain/schemas"

import { ActionError } from "./action-error"
import { useServerAction } from "./use-server-action"

export type TubeSettings = {
  id: string
  name: string
  description?: string
  enabled: boolean
  schemaDefinition?: Record<string, unknown>
  retryPolicy?: RetryPolicy
  leaseSeconds?: number
  nextTubeIds?: string[]
}

export type TubeOption = { id: string; name: string }

/**
 * "Settings" button + dialog editing name, description, enabled, JSON schema
 * and retry policy overrides (`retryDefaults` = server defaults, shown as
 * placeholders for empty fields).
 */
export function TubeSettingsDialog({
  tube,
  retryDefaults,
  leaseDefault,
  tubeOptions,
}: {
  tube: TubeSettings
  retryDefaults: ResolvedRetryPolicy
  /** Server default lease seconds (placeholder). */
  leaseDefault: number
  /** Other tubes this one may hand off to. */
  tubeOptions: TubeOption[]
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Settings2Icon />
        Settings
      </DialogTrigger>
      <DialogContent className="grid-rows-[minmax(0,1fr)] sm:max-w-lg">
        {open && (
          <SettingsForm
            tube={tube}
            retryDefaults={retryDefaults}
            leaseDefault={leaseDefault}
            tubeOptions={tubeOptions}
            close={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SettingsForm({
  tube,
  retryDefaults,
  leaseDefault,
  tubeOptions,
  close,
}: {
  tube: TubeSettings
  retryDefaults: ResolvedRetryPolicy
  leaseDefault: number
  tubeOptions: TubeOption[]
  close: () => void
}) {
  const { pending, error, run } = useServerAction()
  const [enabled, setEnabled] = React.useState(tube.enabled)
  const [schemaText, setSchemaText] = React.useState(() =>
    tube.schemaDefinition ? JSON.stringify(tube.schemaDefinition, null, 2) : ""
  )
  const schema = parseSchemaText(schemaText)
  const [retryFields, setRetryFields] = React.useState<RetryPolicyFields>(() =>
    retryPolicyFields(tube.retryPolicy)
  )
  const retry = parseRetryPolicyFields(retryFields)
  const retryError = (key: keyof RetryPolicyFields) =>
    retry.ok ? undefined : retry.errors[key]
  const setRetryField = (key: keyof RetryPolicyFields, value: string) =>
    setRetryFields((fields) => ({ ...fields, [key]: value }))
  const [leaseText, setLeaseText] = React.useState(
    tube.leaseSeconds === undefined ? "" : String(tube.leaseSeconds)
  )
  const lease = parseLeaseSeconds(leaseText)
  const [nextTubeIds, setNextTubeIds] = React.useState<string[]>(
    tube.nextTubeIds ?? []
  )
  // Targets no longer listed (deleted / out of scope) are kept as they are.
  const options = [
    ...tubeOptions,
    ...nextTubeIds
      .filter((id) => !tubeOptions.some((t) => t.id === id))
      .map((id) => ({ id, name: id })),
  ]
  const toggleNext = (id: string, on: boolean) =>
    setNextTubeIds((ids) =>
      on ? [...ids, id] : ids.filter((other) => other !== id)
    )

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!schema.ok || !retry.ok || !lease.ok) return
    const form = new FormData(event.currentTarget)
    const description = String(form.get("description") ?? "").trim()
    run(
      () =>
        updateTubeAction(tube.id, {
          name: String(form.get("name") ?? ""),
          // empty clears an existing description; untouched stays omitted
          description: description || (tube.description ? null : undefined),
          enabled,
          schemaDefinition:
            schema.value ?? (tube.schemaDefinition ? null : undefined),
          // all fields empty clears existing overrides (server defaults)
          retryPolicy: retry.value ?? (tube.retryPolicy ? null : undefined),
          leaseSeconds:
            lease.value ?? (tube.leaseSeconds !== undefined ? null : undefined),
          nextTubeIds:
            nextTubeIds.length > 0
              ? nextTubeIds
              : tube.nextTubeIds?.length
                ? null
                : undefined,
        }),
      (updated) => {
        toast.success(`Tube “${updated.name}” saved`)
        close()
      }
    )
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex min-h-0 flex-col gap-4"
      noValidate
    >
      <DialogHeader>
        <DialogTitle>Tube settings</DialogTitle>
        <DialogDescription>
          Changes apply immediately to REST, MCP and agents.
        </DialogDescription>
      </DialogHeader>
      <div className="-mx-4 grid min-h-0 flex-1 gap-4 overflow-y-auto px-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="settings-name">Name</FieldLabel>
            <Input
              id="settings-name"
              name="name"
              defaultValue={tube.name}
              maxLength={200}
              aria-invalid={error?.code === "validation_error" || undefined}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-description">Description</FieldLabel>
            <Textarea
              id="settings-description"
              name="description"
              defaultValue={tube.description ?? ""}
              placeholder="Optional"
              maxLength={2000}
              rows={2}
            />
          </Field>
          <Field orientation="horizontal">
            <Switch
              id="settings-enabled"
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked)}
            />
            <FieldLabel htmlFor="settings-enabled">
              Enabled
              <FieldDescription className="sr-only">
                Disabled tubes reject new items and claims
              </FieldDescription>
            </FieldLabel>
          </Field>
          <Field data-invalid={!schema.ok || undefined}>
            <FieldLabel htmlFor="settings-schema">JSON Schema</FieldLabel>
            <Textarea
              id="settings-schema"
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
              placeholder='{ "type": "object", "required": ["email"] }'
              rows={10}
              spellCheck={false}
              className="max-h-80 font-mono text-[0.7rem]"
              aria-invalid={!schema.ok || undefined}
            />
            {schema.ok ? (
              <FieldDescription>
                New item payloads must match it. Leave empty for no schema.
              </FieldDescription>
            ) : (
              <FieldError>{schema.error}</FieldError>
            )}
          </Field>
          <FieldSet>
            <FieldLegend variant="label">Retry policy</FieldLegend>
            <FieldDescription>
              Failed items and expired leases are retried while attempts remain.
              Empty fields use the server defaults.
            </FieldDescription>
            <div className="grid grid-cols-2 gap-3">
              <RetryNumberField
                id="settings-retry-max-attempts"
                label="Max attempts"
                value={retryFields.maxAttempts}
                placeholder={retryDefaults.maxAttempts}
                error={retryError("maxAttempts")}
                onChange={(v) => setRetryField("maxAttempts", v)}
              />
              <Field data-invalid={!!retryError("backoff") || undefined}>
                <FieldLabel htmlFor="settings-retry-backoff">
                  Backoff
                </FieldLabel>
                <NativeSelect
                  id="settings-retry-backoff"
                  className="w-full"
                  value={retryFields.backoff}
                  onChange={(e) => setRetryField("backoff", e.target.value)}
                >
                  <NativeSelectOption value="">
                    {`Default (${retryDefaults.backoff})`}
                  </NativeSelectOption>
                  {BACKOFF_STRATEGIES.map((strategy) => (
                    <NativeSelectOption key={strategy} value={strategy}>
                      {strategy}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <RetryNumberField
                id="settings-retry-delay"
                label="Delay (s)"
                value={retryFields.delaySeconds}
                placeholder={retryDefaults.delaySeconds}
                error={retryError("delaySeconds")}
                onChange={(v) => setRetryField("delaySeconds", v)}
              />
              <RetryNumberField
                id="settings-retry-max-delay"
                label="Max delay (s)"
                value={retryFields.maxDelaySeconds}
                placeholder={retryDefaults.maxDelaySeconds}
                error={retryError("maxDelaySeconds")}
                onChange={(v) => setRetryField("maxDelaySeconds", v)}
              />
            </div>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">Pipeline</FieldLegend>
            <FieldDescription>
              Default lease for long jobs, and the stages this tube hands its
              output to (agents connected to just this tube may push there via
              complete_item next).
            </FieldDescription>
            <Field data-invalid={!lease.ok || undefined}>
              <FieldLabel htmlFor="settings-lease">Lease (s)</FieldLabel>
              <Input
                id="settings-lease"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_LEASE_SECONDS}
                step={1}
                value={leaseText}
                placeholder={`Default: ${leaseDefault}`}
                onChange={(e) => setLeaseText(e.target.value)}
                aria-invalid={!lease.ok || undefined}
              />
              {!lease.ok && <FieldError>{lease.error}</FieldError>}
            </Field>
            <Field>
              <FieldLabel>Hands off to</FieldLabel>
              {options.length === 0 ? (
                <FieldDescription>No other tubes.</FieldDescription>
              ) : (
                <div className="grid max-h-40 gap-2 overflow-y-auto rounded-md border p-2">
                  {options.map((t) => (
                    <label
                      key={t.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={nextTubeIds.includes(t.id)}
                        onChange={(e) => toggleNext(t.id, e.target.checked)}
                      />
                      <span className="truncate">{t.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </Field>
          </FieldSet>
        </FieldGroup>
        <ActionError error={error} />
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button
          type="submit"
          disabled={pending || !schema.ok || !retry.ok || !lease.ok}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  )
}

function RetryNumberField({
  id,
  label,
  value,
  placeholder,
  error,
  onChange,
}: {
  id: string
  label: string
  value: string
  placeholder: number
  error?: string
  onChange: (value: string) => void
}) {
  return (
    <Field data-invalid={!!error || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={value}
        placeholder={`Default: ${placeholder}`}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error || undefined}
      />
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}
