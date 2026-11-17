"use client"

import {
  BanIcon,
  CheckIcon,
  CopyIcon,
  EyeIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import {
  createApiKeyAction,
  deleteApiKeyAction,
  revealApiKeySecretAction,
  revokeApiKeyAction,
  rotateApiKeyAction,
  updateApiKeyAction,
} from "@/app/dashboard/access/actions"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  keyFormInput,
  scopeOptions,
  scopeSummary,
  type KeyFormFields,
} from "@/lib/dashboard/api-keys"
import { ROLE_META, ROLES, type Role } from "@mcpocket/core/domain/access"
import type { ApiKeyView } from "@mcpocket/core/services/api-keys"
import { cn } from "@/lib/utils"

import { ActionError } from "./action-error"
import { useExplorer } from "./explorer-dialogs"
import { useServerAction } from "./use-server-action"
import { UtcTime } from "./utc-time"

type PanelDialog =
  | { kind: "create" }
  | { kind: "edit"; key: ApiKeyView }
  | { kind: "rotate" | "revoke" | "delete"; key: ApiKeyView }
  | {
      kind: "secret"
      key: ApiKeyView
      secret: string
      reason: "created" | "rotated" | "revealed"
    }

/**
 * API keys / agent identities with their role, scope, agent binding and rate
 * limit (ticket 16). Env keys (MCPOCKET_API_KEYS) are listed read-only.
 */
export function ApiKeysPanel({
  keys,
  defaultRateLimit,
}: {
  keys: ApiKeyView[]
  defaultRateLimit: number
}) {
  const [dialog, setDialog] = React.useState<PanelDialog | null>(null)
  const { tree, rootTubes } = useExplorer()

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">API keys & agent identities</h2>
        <Button size="sm" onClick={() => setDialog({ kind: "create" })}>
          <PlusIcon /> New API key
        </Button>
      </div>

      {keys.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon />
            </EmptyMedia>
            <EmptyTitle>No API keys</EmptyTitle>
            <EmptyDescription>
              Create a key for each agent or integration. Its secret is shown
              once, or whenever you need it if you choose so.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead className="text-right">Req/min</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => {
                const scope = scopeSummary(key.scope, tree, rootTubes)
                return (
                  <TableRow
                    key={`${key.source}:${key.id}`}
                    data-key-id={key.id}
                    className={cn(key.status === "revoked" && "opacity-60")}
                  >
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs">{key.id}</span>
                        {key.source === "env" && (
                          <Badge variant="outline">env</Badge>
                        )}
                        {key.status === "revoked" && (
                          <Badge variant="destructive">revoked</Badge>
                        )}
                        {key.secretVisibility === "always" && (
                          <Badge
                            variant="outline"
                            title="The secret is stored and can be shown again"
                          >
                            viewable
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {key.secretPrefix && (
                          <span className="font-mono">{key.secretPrefix}…</span>
                        )}{" "}
                        {key.description}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={key.role === "admin" ? "default" : "secondary"}
                        title={ROLE_META[key.role].description}
                      >
                        {ROLE_META[key.role].label}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="max-w-56 truncate text-xs"
                      title={scope.paths.join("\n")}
                    >
                      {scope.label}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {key.agentId ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {key.rateLimitPerMinute === null
                        ? `${defaultRateLimit || "∞"} (default)`
                        : key.rateLimitPerMinute === 0
                          ? "∞"
                          : key.rateLimitPerMinute}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {key.createdAt ? <UtcTime iso={key.createdAt} /> : "—"}
                    </TableCell>
                    <TableCell>
                      {key.source === "managed" && (
                        <KeyActions
                          key={key.id}
                          apiKey={key}
                          open={setDialog}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
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
              key={`${dialog.kind}:${"key" in dialog ? dialog.key.id : ""}`}
              dialog={dialog}
              setDialog={setDialog}
              defaultRateLimit={defaultRateLimit}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function KeyActions({
  apiKey,
  open,
}: {
  apiKey: ApiKeyView
  open: (dialog: PanelDialog) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${apiKey.id}`}
          />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {apiKey.secretVisibility === "always" && (
          <RevealSecretItem apiKey={apiKey} open={open} />
        )}
        <DropdownMenuItem onClick={() => open({ kind: "edit", key: apiKey })}>
          <PencilIcon /> Edit permissions
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open({ kind: "rotate", key: apiKey })}>
          <RefreshCwIcon />{" "}
          {apiKey.status === "revoked" ? "Re-activate" : "Rotate secret"}
        </DropdownMenuItem>
        {apiKey.status === "active" && (
          <DropdownMenuItem
            onClick={() => open({ kind: "revoke", key: apiKey })}
          >
            <BanIcon /> Revoke
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => open({ kind: "delete", key: apiKey })}
        >
          <Trash2Icon /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RevealSecretItem({
  apiKey,
  open,
}: {
  apiKey: ApiKeyView
  open: (dialog: PanelDialog) => void
}) {
  const [pending, startTransition] = React.useTransition()
  const reveal = () =>
    startTransition(async () => {
      const result = await revealApiKeySecretAction(apiKey.id)
      if (result.ok) {
        open({
          kind: "secret",
          key: apiKey,
          secret: result.data,
          reason: "revealed",
        })
      } else {
        toast.error(result.error.message)
      }
    })
  return (
    <DropdownMenuItem disabled={pending} onClick={reveal}>
      <EyeIcon /> Show secret
    </DropdownMenuItem>
  )
}

type BodyProps = {
  dialog: PanelDialog
  setDialog: (dialog: PanelDialog | null) => void
  defaultRateLimit: number
}

function DialogBody(props: BodyProps) {
  switch (props.dialog.kind) {
    case "create":
    case "edit":
      return <KeyForm {...props} />
    case "secret":
      return <SecretReveal {...props} />
    default:
      return <ConfirmKeyAction {...props} />
  }
}

function initialFields(key: ApiKeyView | null): KeyFormFields {
  return {
    id: key?.id ?? "",
    description: key?.description ?? "",
    role: key?.role ?? "agent",
    scopeMode: key?.scope ? "selected" : "all",
    folderIds: key?.scope?.folderIds ?? [],
    tubeIds: key?.scope?.tubeIds ?? [],
    agentId: key?.agentId ?? "",
    rateLimit:
      key?.rateLimitPerMinute === null || key === null
        ? ""
        : String(key.rateLimitPerMinute),
    secretVisibility: key?.secretVisibility ?? "always",
  }
}

function KeyForm({ dialog, setDialog, defaultRateLimit }: BodyProps) {
  const editing = dialog.kind === "edit" ? dialog.key : null
  const [fields, setFields] = React.useState(() => initialFields(editing))
  const { pending, error, run } = useServerAction()
  const { tree, rootTubes } = useExplorer()
  const options = React.useMemo(
    () => scopeOptions(tree, rootTubes),
    [tree, rootTubes]
  )
  const set = (patch: Partial<KeyFormFields>) =>
    setFields((f) => ({ ...f, ...patch }))

  const toggle = (kind: "folder" | "tube", id: string) => {
    const key = kind === "folder" ? "folderIds" : "tubeIds"
    setFields((f) => ({
      ...f,
      [key]: f[key].includes(id)
        ? f[key].filter((x) => x !== id)
        : [...f[key], id],
    }))
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    const input = keyFormInput(fields, editing !== null)
    if (editing) {
      run(
        () => updateApiKeyAction(editing.id, input),
        (key) => {
          toast.success(`Permissions of “${key.id}” updated`)
          setDialog(null)
        }
      )
    } else {
      run(
        () => createApiKeyAction(input),
        ({ key, secret }) =>
          setDialog({ kind: "secret", key, secret, reason: "created" })
      )
    }
  }

  const scoped = fields.role !== "admin" && fields.scopeMode === "selected"

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          {editing ? `Edit “${editing.id}”` : "New API key"}
        </DialogTitle>
        <DialogDescription>
          The role decides what the key may do; the scope limits where (folders
          include everything below them).
        </DialogDescription>
      </DialogHeader>
      <FieldGroup className="max-h-[60vh] overflow-y-auto pr-1">
        {!editing && (
          <Field>
            <FieldLabel htmlFor="key-id">Key id</FieldLabel>
            <Input
              id="key-id"
              required
              value={fields.id}
              onChange={(e) => set({ id: e.target.value })}
              placeholder="ingest-bot"
              autoComplete="off"
            />
            <FieldDescription>
              Shown as <code>api_key:&lt;id&gt;</code> in audit history. Cannot
              be changed later.
            </FieldDescription>
          </Field>
        )}
        {!editing && (
          <Field>
            <FieldLabel>Secret visibility</FieldLabel>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
              {SECRET_VISIBILITY_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    "flex cursor-pointer flex-col gap-1 border p-2 text-xs hover:bg-muted/40",
                    fields.secretVisibility === option.value &&
                      "border-primary bg-primary/5"
                  )}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <input
                      type="radio"
                      name="key-secret-visibility"
                      className="accent-primary"
                      value={option.value}
                      checked={fields.secretVisibility === option.value}
                      onChange={() => set({ secretVisibility: option.value })}
                    />
                    {option.label}
                  </span>
                  <span className="text-muted-foreground">
                    {option.description}
                  </span>
                </label>
              ))}
            </div>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="key-description">Description</FieldLabel>
          <Input
            id="key-description"
            value={fields.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="key-role">Role</FieldLabel>
          <NativeSelect
            id="key-role"
            value={fields.role}
            onChange={(e) => set({ role: e.target.value as Role })}
          >
            {ROLES.map((role) => (
              <NativeSelectOption key={role} value={role}>
                {ROLE_META[role].label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>
            {ROLE_META[fields.role].description}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="key-scope">Scope</FieldLabel>
          <NativeSelect
            id="key-scope"
            value={fields.role === "admin" ? "all" : fields.scopeMode}
            disabled={fields.role === "admin"}
            onChange={(e) =>
              set({ scopeMode: e.target.value as KeyFormFields["scopeMode"] })
            }
          >
            <NativeSelectOption value="all">
              All folders & tubes
            </NativeSelectOption>
            <NativeSelectOption value="selected">
              Selected folders / tubes
            </NativeSelectOption>
          </NativeSelect>
          {scoped && (
            <div
              className="max-h-56 overflow-y-auto border p-1"
              data-testid="scope-picker"
            >
              {options.length === 0 && (
                <p className="p-2 text-xs text-muted-foreground">
                  No folders yet.
                </p>
              )}
              {options.map((o) => {
                const checked = (
                  o.kind === "folder" ? fields.folderIds : fields.tubeIds
                ).includes(o.id)
                return (
                  <label
                    key={`${o.kind}:${o.id}`}
                    className="flex cursor-pointer items-center gap-2 px-1 py-0.5 text-xs hover:bg-muted"
                    style={{ paddingLeft: `${o.depth * 14 + 4}px` }}
                    title={o.path}
                  >
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={checked}
                      onChange={() => toggle(o.kind, o.id)}
                    />
                    <span
                      className={cn(
                        o.kind === "tube" && "text-muted-foreground"
                      )}
                    >
                      {o.kind === "folder" ? `${o.name}/` : o.name}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="key-agent">Agent identity (optional)</FieldLabel>
          <Input
            id="key-agent"
            value={fields.agentId}
            onChange={(e) => set({ agentId: e.target.value })}
            placeholder="summarizer-1"
            autoComplete="off"
          />
          <FieldDescription>
            Binds the key to one agent: requests act as this agent (an
            X-Agent-Id header must match).
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="key-rate">
            Rate limit (requests/minute)
          </FieldLabel>
          <Input
            id="key-rate"
            type="number"
            min={0}
            value={fields.rateLimit}
            onChange={(e) => set({ rateLimit: e.target.value })}
            placeholder={`${defaultRateLimit} (server default)`}
          />
          <FieldDescription>
            Empty = server default, 0 = unlimited.
          </FieldDescription>
        </Field>
      </FieldGroup>
      <ActionError error={error} />
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : editing ? "Save" : "Create key"}
        </Button>
      </DialogFooter>
    </form>
  )
}

const SECRET_VISIBILITY_OPTIONS = [
  {
    value: "always",
    label: "Show each time",
    description:
      "Also stored in clear: view it later and get ready-made URLs on the MCP page.",
  },
  {
    value: "once",
    label: "Show only on create",
    description:
      "Stored hashed. Copy it now; a lost secret can only be rotated.",
  },
] as const

const SECRET_TITLE = {
  created: "API key created",
  rotated: "New secret",
  revealed: "Secret",
} as const

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
          {SECRET_TITLE[dialog.reason]} — “{dialog.key.id}”
        </DialogTitle>
        <DialogDescription>
          {dialog.key.secretVisibility === "always"
            ? "You can show this secret again from the key's menu."
            : "Copy the secret now: it is stored hashed and will not be shown again."}{" "}
          Send it as <code>Authorization: Bearer &lt;secret&gt;</code> or{" "}
          <code>?api_key=&lt;secret&gt;</code>.
        </DialogDescription>
      </DialogHeader>
      <div className="flex gap-2">
        <Input
          readOnly
          value={dialog.secret}
          className="font-mono"
          data-testid="api-key-secret"
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
    title: "Rotate secret?",
    text: "A new secret is generated and the current one stops working immediately.",
    button: "Rotate",
  },
  revoke: {
    title: "Revoke key?",
    text: "The key stops authenticating immediately. Rotating its secret re-activates it.",
    button: "Revoke",
  },
  delete: {
    title: "Delete key?",
    text: "The key is removed for good. Its audit trail stays.",
    button: "Delete",
  },
} as const

function ConfirmKeyAction({ dialog, setDialog }: BodyProps) {
  const { pending, error, run } = useServerAction()
  if (
    dialog.kind !== "rotate" &&
    dialog.kind !== "revoke" &&
    dialog.kind !== "delete"
  ) {
    return null
  }
  const { key, kind } = dialog
  const copy = CONFIRM_COPY[kind]

  function onConfirm() {
    if (kind === "rotate") {
      run(
        () => rotateApiKeyAction(key.id),
        (result) => setDialog({ kind: "secret", ...result, reason: "rotated" })
      )
    } else if (kind === "revoke") {
      run(
        () => revokeApiKeyAction(key.id),
        () => {
          toast.success(`Key “${key.id}” revoked`)
          setDialog(null)
        }
      )
    } else {
      run<undefined>(
        () => deleteApiKeyAction(key.id),
        () => {
          toast.success(`Key “${key.id}” deleted`)
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
          “{key.id}”: {copy.text}
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
