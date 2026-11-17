"use client"

import {
  CheckIcon,
  CopyIcon,
  ListIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react"
import Link from "next/link"
import * as React from "react"
import { toast } from "sonner"

import {
  createWebhookAction,
  deleteWebhookAction,
  rotateWebhookSecretAction,
  testWebhookAction,
  updateWebhookAction,
} from "@/app/dashboard/webhooks/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { scopeOptions } from "@/lib/dashboard/api-keys"
import {
  WEBHOOK_EVENT_LABELS,
  webhookFormInput,
  webhookScopeValue,
  webhooksHref,
  type WebhookFormFields,
  type WebhooksQuery,
} from "@/lib/dashboard/webhooks"
import { WEBHOOK_EVENT_TYPES } from "@mcpocket/core/domain/schemas"
import type { WebhookView } from "@mcpocket/core/services/webhooks"
import { cn } from "@/lib/utils"

import { ActionError } from "./action-error"
import { useExplorer } from "./explorer-dialogs"
import { useServerAction } from "./use-server-action"

type PanelDialog =
  | { kind: "create" }
  | { kind: "edit"; webhook: WebhookView }
  | { kind: "rotate" | "delete"; webhook: WebhookView }
  | { kind: "secret"; webhook: WebhookView; secret: string; rotated: boolean }

/** Webhook subscriptions (ticket 17). */
export function WebhooksPanel({
  webhooks,
  query,
}: {
  webhooks: WebhookView[]
  query: WebhooksQuery
}) {
  const [dialog, setDialog] = React.useState<PanelDialog | null>(null)
  const { tree, rootTubes } = useExplorer()
  const paths = React.useMemo(
    () =>
      new Map(
        scopeOptions(tree, rootTubes).map((o) => [`${o.kind}:${o.id}`, o])
      ),
    [tree, rootTubes]
  )
  const scopeLabel = (w: WebhookView) => {
    const value = webhookScopeValue(w)
    if (!value) return "Everywhere"
    const option = paths.get(value)
    return option
      ? `${option.kind === "folder" ? "Folder" : "Tube"}: ${option.path}`
      : `${w.tubeId ? "Tube" : "Folder"} ${value.split(":")[1].slice(0, 8)} (deleted)`
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Subscriptions</h2>
        <Button size="sm" onClick={() => setDialog({ kind: "create" })}>
          <PlusIcon /> New webhook
        </Button>
      </div>

      {webhooks.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WebhookIcon />
            </EmptyMedia>
            <EmptyTitle>No webhooks</EmptyTitle>
            <EmptyDescription>
              Register a URL to be notified when items are created, change
              status or are deleted.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Webhook</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead className="text-right">Pending</TableHead>
                <TableHead className="text-right">Delivered</TableHead>
                <TableHead className="text-right">Dead</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {webhooks.map((w) => (
                <TableRow
                  key={w.id}
                  data-webhook-id={w.id}
                  className={cn(!w.enabled && "opacity-60")}
                >
                  <TableCell className="max-w-72">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{w.name}</span>
                      {!w.enabled && <Badge variant="outline">disabled</Badge>}
                    </div>
                    <div
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={w.url}
                    >
                      {w.url}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {w.eventTypes.length === 0
                      ? "All item events"
                      : w.eventTypes.join(", ")}
                  </TableCell>
                  <TableCell className="max-w-56 truncate text-xs">
                    {scopeLabel(w)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {w.deliveries.pending}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {w.deliveries.delivered}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right text-xs tabular-nums",
                      w.deliveries.dead > 0 && "text-destructive"
                    )}
                  >
                    {w.deliveries.dead}
                  </TableCell>
                  <TableCell>
                    <WebhookActions
                      webhook={w}
                      open={setDialog}
                      deliveriesHref={webhooksHref(query, {
                        webhook: w.id,
                      })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          {dialog && (
            <DialogBody
              key={`${dialog.kind}:${"webhook" in dialog ? dialog.webhook.id : ""}`}
              dialog={dialog}
              setDialog={setDialog}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function WebhookActions({
  webhook,
  open,
  deliveriesHref,
}: {
  webhook: WebhookView
  open: (dialog: PanelDialog) => void
  deliveriesHref: string
}) {
  const [, startTransition] = React.useTransition()
  const test = () =>
    startTransition(async () => {
      const result = await testWebhookAction(webhook.id)
      if (result.ok) {
        toast.success(`Test delivery queued for “${webhook.name}”`)
      } else {
        toast.error(result.error.message)
      }
    })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${webhook.name}`}
          />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={() => open({ kind: "edit", webhook })}>
          <PencilIcon /> Edit
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link href={deliveriesHref} />}>
          <ListIcon /> Deliveries
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!webhook.enabled} onClick={test}>
          <SendIcon /> Send test event
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open({ kind: "rotate", webhook })}>
          <RefreshCwIcon /> Rotate secret
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => open({ kind: "delete", webhook })}
        >
          <Trash2Icon /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type BodyProps = {
  dialog: PanelDialog
  setDialog: (dialog: PanelDialog | null) => void
}

function DialogBody(props: BodyProps) {
  switch (props.dialog.kind) {
    case "create":
    case "edit":
      return <WebhookForm {...props} />
    case "secret":
      return <SecretReveal {...props} />
    default:
      return <ConfirmAction {...props} />
  }
}

function initialFields(webhook: WebhookView | null): WebhookFormFields {
  return {
    name: webhook?.name ?? "",
    url: webhook?.url ?? "",
    eventTypes:
      !webhook || webhook.eventTypes.length === 0
        ? [...WEBHOOK_EVENT_TYPES]
        : webhook.eventTypes,
    scope: webhook ? webhookScopeValue(webhook) : "",
    enabled: webhook?.enabled ?? true,
  }
}

function WebhookForm({ dialog, setDialog }: BodyProps) {
  const editing = dialog.kind === "edit" ? dialog.webhook : null
  const [fields, setFields] = React.useState(() => initialFields(editing))
  const { pending, error, run } = useServerAction()
  const { tree, rootTubes } = useExplorer()
  const options = React.useMemo(
    () => scopeOptions(tree, rootTubes),
    [tree, rootTubes]
  )
  const set = (patch: Partial<WebhookFormFields>) =>
    setFields((f) => ({ ...f, ...patch }))

  const toggleType = (type: (typeof WEBHOOK_EVENT_TYPES)[number]) =>
    setFields((f) => ({
      ...f,
      eventTypes: f.eventTypes.includes(type)
        ? f.eventTypes.filter((t) => t !== type)
        : [...f.eventTypes, type],
    }))

  function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    const input = webhookFormInput(fields)
    if (editing) {
      run(
        () => updateWebhookAction(editing.id, input),
        (w) => {
          toast.success(`Webhook “${w.name}” updated`)
          setDialog(null)
        }
      )
    } else {
      run(
        () => createWebhookAction(input),
        ({ webhook, secret }) =>
          setDialog({ kind: "secret", webhook, secret, rotated: false })
      )
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          {editing ? `Edit “${editing.name}”` : "New webhook"}
        </DialogTitle>
        <DialogDescription>
          MCPocket POSTs a signed JSON event to this URL for every matching item
          change.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup className="max-h-[60vh] overflow-y-auto pr-1">
        <Field>
          <FieldLabel htmlFor="webhook-name">Name</FieldLabel>
          <Input
            id="webhook-name"
            required
            value={fields.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="CRM sync"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="webhook-url">URL</FieldLabel>
          <Input
            id="webhook-url"
            required
            type="url"
            value={fields.url}
            onChange={(e) => set({ url: e.target.value })}
            placeholder="https://example.com/hooks/mcpocket"
            autoComplete="off"
          />
        </Field>
        <Field>
          <FieldLabel>Events</FieldLabel>
          <div className="grid gap-1" data-testid="webhook-event-types">
            {WEBHOOK_EVENT_TYPES.map((type) => (
              <label
                key={type}
                className="flex cursor-pointer items-center gap-2 text-xs"
              >
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={fields.eventTypes.includes(type)}
                  onChange={() => toggleType(type)}
                />
                <code>{type}</code>
                <span className="text-muted-foreground">
                  {WEBHOOK_EVENT_LABELS[type]}
                </span>
              </label>
            ))}
          </div>
          <FieldDescription>
            All checked (or none) = every item event.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="webhook-scope">Scope</FieldLabel>
          <NativeSelect
            id="webhook-scope"
            value={fields.scope}
            onChange={(e) => set({ scope: e.target.value })}
          >
            <NativeSelectOption value="">
              All folders & tubes
            </NativeSelectOption>
            {options.map((o) => (
              <NativeSelectOption
                key={`${o.kind}:${o.id}`}
                value={`${o.kind}:${o.id}`}
              >
                {"\u00a0\u00a0".repeat(o.depth)}
                {o.kind === "folder" ? `${o.name}/` : o.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>
            A folder includes every tube below it.
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <Switch
            id="webhook-enabled"
            checked={fields.enabled}
            onCheckedChange={(checked) => set({ enabled: checked })}
          />
          <FieldLabel htmlFor="webhook-enabled">Enabled</FieldLabel>
        </Field>
      </FieldGroup>
      <ActionError error={error} />
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : editing ? "Save" : "Create webhook"}
        </Button>
      </DialogFooter>
    </form>
  )
}

function SecretReveal({ dialog, setDialog }: BodyProps) {
  const [copied, setCopied] = React.useState(false)
  if (dialog.kind !== "secret") return null
  const copy = async () => {
    await navigator.clipboard.writeText(dialog.secret)
    setCopied(true)
  }
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          {dialog.rotated ? "New signing secret" : "Webhook created"} — “
          {dialog.webhook.name}”
        </DialogTitle>
        <DialogDescription>
          Copy the signing secret now: it will not be shown again. Verify each
          request by computing HMAC-SHA256 of <code>{"{t}.{raw body}"}</code>{" "}
          with it and comparing to <code>v1</code> in{" "}
          <code>X-MCPocket-Signature</code>.
        </DialogDescription>
      </DialogHeader>
      <div className="flex gap-2">
        <Input
          readOnly
          value={dialog.secret}
          className="font-mono"
          data-testid="webhook-secret"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <DialogFooter>
        <Button type="button" onClick={() => setDialog(null)}>
          Done
        </Button>
      </DialogFooter>
    </div>
  )
}

const CONFIRM_COPY = {
  rotate: {
    title: "Rotate signing secret?",
    text: "A new secret is generated and used for every delivery from now on, including retries.",
    button: "Rotate",
  },
  delete: {
    title: "Delete webhook?",
    text: "The subscription and its pending and past deliveries are removed.",
    button: "Delete",
  },
} as const

function ConfirmAction({ dialog, setDialog }: BodyProps) {
  const { pending, error, run } = useServerAction()
  if (dialog.kind !== "rotate" && dialog.kind !== "delete") return null
  const { webhook, kind } = dialog
  const copy = CONFIRM_COPY[kind]

  function onConfirm() {
    if (kind === "rotate") {
      run(
        () => rotateWebhookSecretAction(webhook.id),
        (result) => setDialog({ kind: "secret", ...result, rotated: true })
      )
    } else {
      run<undefined>(
        () => deleteWebhookAction(webhook.id),
        () => {
          toast.success(`Webhook “${webhook.name}” deleted`)
          setDialog(null)
        }
      )
    }
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>
          “{webhook.name}”: {copy.text}
        </DialogDescription>
      </DialogHeader>
      <ActionError error={error} />
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button
          type="button"
          variant={kind === "rotate" ? "default" : "destructive"}
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? "Working…" : copy.button}
        </Button>
      </DialogFooter>
    </div>
  )
}
