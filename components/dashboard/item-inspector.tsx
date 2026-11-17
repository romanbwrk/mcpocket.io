"use client"

import {
  ArchiveIcon,
  BanIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
  UserRoundCogIcon,
} from "lucide-react"
import { useRouter } from "next/navigation"
import * as React from "react"
import { toast } from "sonner"

import {
  deleteItemAction,
  reassignItemAction,
  updateItemAction,
} from "@/app/dashboard/actions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { formatJson, validatePayloadText } from "@/lib/dashboard/json-text"
import {
  CLAIM_ONLY_STATUSES,
  canTransitionManually,
} from "@mcpocket/core/domain/item-status"
import type { PageResult } from "@mcpocket/core/domain/pagination"
import {
  ITEM_STATUSES,
  type HistoryEvent,
  type Item,
  type ItemStatus,
} from "@mcpocket/core/domain/schemas"

import { ActionError } from "./action-error"
import { ItemHistoryTimeline } from "./item-history"
import { ITEM_STATUS_META, ItemStatusBadge } from "./item-status"
import { JsonEditor, JsonView } from "./json-editor"
import { UtcTime } from "./utc-time"
import { useServerAction } from "./use-server-action"

export type ItemInspectorData =
  | {
      found: true
      item: Item
      history: PageResult<HistoryEvent>
      /** Tube of the item: its schema drives live payload validation. */
      tube: {
        id: string
        name: string
        schemaDefinition?: Record<string, unknown>
      }
    }
  | { found: false; id: string }

/**
 * Item inspector (right sheet), opened by the tube view's `?item=<id>` URL
 * param. Every write goes through dashboard server actions → the same item
 * services as REST/MCP; the action revalidates the page, so the inspector,
 * counters and rows re-render with fresh server data.
 */
export function ItemInspector({
  data,
  closeHref,
}: {
  data: ItemInspectorData
  closeHref: string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(true)
  const close = React.useCallback(() => {
    setOpen(false)
    router.push(closeHref, { scroll: false })
  }, [router, closeHref])

  return (
    <Sheet open={open} onOpenChange={(next) => !next && close()}>
      <SheetContent
        side="right"
        className="w-full data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        data-testid="item-inspector"
      >
        {data.found ? (
          <InspectorBody data={data} close={close} />
        ) : (
          <SheetHeader>
            <SheetTitle>Item not found</SheetTitle>
            <SheetDescription>
              No item with id <code className="font-mono">{data.id}</code>.
            </SheetDescription>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  )
}

function InspectorBody({
  data,
  close,
}: {
  data: Extract<ItemInspectorData, { found: true }>
  close: () => void
}) {
  const { item, history, tube } = data
  const deleted = Boolean(item.deletedAt)
  return (
    <>
      <SheetHeader className="border-b pr-12">
        <div className="flex flex-wrap items-center gap-2">
          <SheetTitle>
            Item <code className="font-mono">{item.id.slice(0, 8)}</code>
          </SheetTitle>
          <ItemStatusBadge status={item.status} />
          {deleted && <Badge variant="destructive">Deleted</Badge>}
        </div>
        <SheetDescription className="font-mono break-all">
          {item.id} · {tube.name}
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <ItemDetails item={item} />
        {!deleted && <ItemActions item={item} close={close} />}
        <PayloadEditor
          key={item.id}
          item={item}
          schema={tube.schemaDefinition}
          readOnly={deleted}
        />
        <ResultSection item={item} />
        <Section title="Metadata">
          <JsonView value={item.metadata} data-testid="item-metadata" />
        </Section>
        <Section
          title="History"
          aside={
            history.page.total > history.data.length
              ? `${history.data.length} of ${history.page.total} newest`
              : `${history.page.total} events`
          }
        >
          <ItemHistoryTimeline events={history.data} />
        </Section>
      </div>
    </>
  )
}

function Section({
  title,
  aside,
  children,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        {aside && (
          <span className="text-[0.7rem] text-muted-foreground">{aside}</span>
        )}
      </div>
      {children}
    </section>
  )
}

const dash = <span className="text-muted-foreground">—</span>

function Detail({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  )
}

function ItemDetails({ item }: { item: Item }) {
  const time = (iso?: string | null) =>
    iso ? <UtcTime iso={iso} seconds /> : dash
  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 sm:grid-cols-[auto_1fr_auto_1fr]"
      data-testid="item-details"
    >
      <Detail label="Priority">
        <span className="tabular-nums">{item.priority}</span>
      </Detail>
      <Detail label="Attempts">
        <span className="tabular-nums">{item.attempts}</span>
      </Detail>
      <Detail label="Agent">{item.assignedAgent ?? dash}</Detail>
      <Detail label="Lease expires">{time(item.leaseExpiresAt)}</Detail>
      {item.status === "retry" && (
        <Detail label="Retry after">{time(item.retryAt)}</Detail>
      )}
      <Detail label="Tags">
        {item.tags.length ? (
          <span className="flex flex-wrap gap-1">
            {item.tags.map((t) => (
              <Badge key={t} variant="secondary">
                {t}
              </Badge>
            ))}
          </span>
        ) : (
          dash
        )}
      </Detail>
      <Detail label="Idempotency key">
        {item.idempotencyKey ? (
          <code className="font-mono break-all">{item.idempotencyKey}</code>
        ) : (
          dash
        )}
      </Detail>
      <Detail label="Created">{time(item.createdAt)}</Detail>
      <Detail label="Updated">{time(item.updatedAt)}</Detail>
      <Detail label="Completed">{time(item.completedAt)}</Detail>
      {item.deletedAt && (
        <Detail label="Deleted">{time(item.deletedAt)}</Detail>
      )}
    </dl>
  )
}

type Confirm = { kind: "archive" } | { kind: "delete" } | null

function ItemActions({ item, close }: { item: Item; close: () => void }) {
  const { pending, error, run } = useServerAction()
  const [confirm, setConfirm] = React.useState<Confirm>(null)
  const [target, setTarget] = React.useState<ItemStatus | "">("")
  const [agent, setAgent] = React.useState(item.assignedAgent ?? "")

  const allowed = (to: ItemStatus) => canTransitionManually(item.status, to)

  function setStatus(status: ItemStatus, label: string) {
    run(
      () => updateItemAction(item.id, { status }),
      () => {
        toast.success(`${label}: ${ITEM_STATUS_META[status].label}`)
        setTarget("")
        setConfirm(null)
      }
    )
  }

  function reassign(agentId: string | null) {
    run(
      () => reassignItemAction(item.id, agentId),
      (updated) => {
        setAgent(updated.assignedAgent ?? "")
        toast.success(
          updated.assignedAgent
            ? `Reassigned to ${updated.assignedAgent}`
            : "Agent unassigned"
        )
      }
    )
  }

  function remove() {
    run(
      () => deleteItemAction(item.id),
      () => {
        toast.success("Item deleted")
        setConfirm(null)
        close()
      }
    )
  }

  const quick: Array<{
    status: ItemStatus
    label: string
    icon: React.ReactNode
    hint: string
  }> = [
    {
      status: "retry",
      label: "Retry",
      icon: <RotateCcwIcon />,
      hint: "Queue for another attempt",
    },
    {
      status: "cancelled",
      label: "Cancel",
      icon: <BanIcon />,
      hint: "Stop processing and clear the lease",
    },
  ]
  const manualTargets = ITEM_STATUSES.filter(
    (s) => s !== item.status && !CLAIM_ONLY_STATUSES.includes(s)
  )

  return (
    <section
      className="flex flex-col gap-3 border bg-card p-3"
      aria-label="Actions"
    >
      <div className="flex flex-wrap gap-2">
        {quick.map((q) => (
          <Button
            key={q.status}
            size="sm"
            variant="outline"
            title={
              allowed(q.status)
                ? q.hint
                : `Not allowed from ${ITEM_STATUS_META[item.status].label}`
            }
            disabled={pending || !allowed(q.status)}
            onClick={() => setStatus(q.status, q.label)}
          >
            {q.icon}
            {q.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !allowed("archived")}
          onClick={() => setConfirm({ kind: "archive" })}
        >
          <ArchiveIcon />
          Archive
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() => setConfirm({ kind: "delete" })}
        >
          <Trash2Icon />
          Delete
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (target) setStatus(target, "Status")
          }}
        >
          <NativeSelect
            size="sm"
            aria-label="New status"
            value={target}
            onChange={(e) => setTarget(e.target.value as ItemStatus | "")}
            className="min-w-0 flex-1"
          >
            <NativeSelectOption value="">Change status…</NativeSelectOption>
            {manualTargets.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {ITEM_STATUS_META[s].label}
                {allowed(s) ? "" : " (not allowed)"}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button size="sm" type="submit" disabled={pending || !target}>
            Apply
          </Button>
        </form>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            reassign(agent.trim() || null)
          }}
        >
          <Input
            aria-label="Agent id"
            placeholder="Agent id"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="h-7 min-w-0 flex-1"
          />
          <Button
            size="sm"
            type="submit"
            variant="outline"
            disabled={pending || agent.trim() === (item.assignedAgent ?? "")}
          >
            <UserRoundCogIcon />
            {agent.trim() ? "Reassign" : "Unassign"}
          </Button>
        </form>
      </div>
      <ActionError error={error} />

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(next) => !next && setConfirm(null)}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "delete" ? "Delete item?" : "Archive item?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "delete"
                ? "The item is hidden from lists and can no longer be changed. Its history is kept."
                : "Archived is a terminal status: the item can no longer be changed or requeued."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ActionError error={error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.kind === "delete" ? "destructive" : "default"}
              disabled={pending}
              onClick={() =>
                confirm?.kind === "delete"
                  ? remove()
                  : setStatus("archived", "Archived")
              }
            >
              {confirm?.kind === "delete" ? "Delete" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function PayloadEditor({
  item,
  schema,
  readOnly,
}: {
  item: Item
  schema?: Record<string, unknown>
  readOnly: boolean
}) {
  const { pending, error, run, setError } = useServerAction()
  const serverText = React.useMemo(
    () => formatJson(item.payload),
    [item.payload]
  )
  const [base, setBase] = React.useState(serverText)
  const [text, setText] = React.useState(base)
  // Live updates refresh `item`: follow a remote payload change unless the
  // admin has unsaved edits — then keep them and flag the conflict instead.
  const [seen, setSeen] = React.useState(serverText)
  const [changedElsewhere, setChangedElsewhere] = React.useState(false)
  if (serverText !== seen) {
    setSeen(serverText)
    if (text === base || text === serverText) {
      setBase(serverText)
      setText(serverText)
      setChangedElsewhere(false)
    } else if (serverText !== base) {
      setChangedElsewhere(true)
    }
  }
  const loadLatest = () => {
    setBase(serverText)
    setText(serverText)
    setChangedElsewhere(false)
    setError(null)
  }
  const deferred = React.useDeferredValue(text)
  const validation = React.useMemo(
    () => validatePayloadText(deferred, schema),
    [deferred, schema]
  )
  const dirty = text !== base || changedElsewhere
  const issues = validation.ok ? [] : validation.issues

  function save() {
    const current = validatePayloadText(text, schema)
    if (!current.ok) return
    run(
      () => updateItemAction(item.id, { payload: current.value }),
      (updated) => {
        const next = formatJson(updated.payload)
        setBase(next)
        setText(next)
        setChangedElsewhere(false)
        toast.success("Payload saved")
      }
    )
  }

  return (
    <Section
      title="Payload"
      aside={schema ? "validated against the tube schema" : "no tube schema"}
    >
      {changedElsewhere && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
          role="status"
          data-testid="payload-changed-elsewhere"
        >
          <span>
            The payload was changed elsewhere. Saving will overwrite it.
          </span>
          <Button size="sm" variant="outline" onClick={loadLatest}>
            Load latest
          </Button>
        </div>
      )}
      <JsonEditor
        value={text}
        onChange={(v) => {
          setText(v)
          setError(null)
        }}
        invalid={!validation.ok}
        readOnly={readOnly}
        aria-label="Payload JSON"
        data-testid="payload-editor"
      />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div
          className="min-w-0 flex-1 text-xs"
          data-testid="payload-validation"
        >
          {validation.ok ? (
            <span className="text-emerald-700 dark:text-emerald-400">
              Valid JSON{schema ? " · matches the tube schema" : ""}
            </span>
          ) : (
            <ul className="space-y-0.5 text-destructive">
              {issues.map((issue, i) => (
                <li key={i}>
                  {validation.kind === "parse"
                    ? "Invalid JSON"
                    : validation.kind === "schema"
                      ? "Schema"
                      : "Invalid"}
                  {issue.line !== undefined &&
                    ` (line ${issue.line}, col ${issue.column})`}
                  {issue.path ? (
                    <>
                      {" "}
                      <code className="font-mono">payload{issue.path}</code>
                    </>
                  ) : null}
                  : {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!validation.ok}
              onClick={() =>
                validation.ok && setText(formatJson(validation.value))
              }
            >
              Format
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty || pending}
              onClick={loadLatest}
            >
              Reset
            </Button>
            <Button
              size="sm"
              disabled={
                !dirty || !validation.ok || pending || text !== deferred
              }
              onClick={save}
            >
              <SaveIcon />
              Save payload
            </Button>
          </div>
        )}
      </div>
      <ActionError error={error} />
    </Section>
  )
}

function ResultSection({ item }: { item: Item }) {
  const error = item.lastError
  return (
    <>
      <Section title="Result">
        {item.result === undefined ? (
          <p className="text-xs text-muted-foreground">
            No result yet — set by <code>complete_item</code> /{" "}
            <code>POST /api/items/{"{id}"}/complete</code>.
          </p>
        ) : (
          <JsonView value={item.result} data-testid="item-result" />
        )}
      </Section>
      {error && (
        <Section title="Last error">
          <div
            className="flex flex-col gap-2 border border-destructive/30 bg-destructive/5 p-3"
            data-testid="item-error"
          >
            <p className="font-medium text-destructive">
              {error.code && (
                <code className="mr-1.5 font-mono">[{error.code}]</code>
              )}
              {error.message}
            </p>
            <p className="text-muted-foreground">
              Attempt {error.attempt}
              {error.agentId && <> · agent {error.agentId}</>} ·{" "}
              <UtcTime iso={error.at} seconds />
            </p>
            {error.details !== undefined && <JsonView value={error.details} />}
          </div>
        </Section>
      )}
    </>
  )
}
