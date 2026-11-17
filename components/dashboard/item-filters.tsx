"use client"

import { cn } from "cn"
import {
  FilterIcon,
  Loader2Icon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react"
import { useRouter } from "next/navigation"
import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  activeFilterCount,
  EMPTY_TUBE_VIEW_QUERY,
  tubeViewHref,
  type PayloadFilterRow,
  type TubeViewQuery,
} from "@/lib/dashboard/tube-query"
import {
  PAYLOAD_FILTER_OPERATORS,
  type PayloadFilterOperator,
} from "@mcpocket/core/domain/item-filter-operators"
import { ITEM_STATUSES, type ItemStatus } from "@mcpocket/core/domain/schemas"

import { ITEM_STATUS_META, StatusDot } from "./item-status"

const OPERATOR_LABELS: Record<PayloadFilterOperator, string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  in: "in (a,b)",
  contains: "contains",
  exists: "exists",
}

const VALUE_PLACEHOLDER: Partial<Record<PayloadFilterOperator, string>> = {
  in: "a,b,c",
  exists: "true / false",
}

type Draft = {
  status: ItemStatus[]
  assignedAgent: string
  createdFrom: string
  createdTo: string
  priorityMin: string
  priorityMax: string
  tags: string
  payload: PayloadFilterRow[]
}

const toDraft = (q: TubeViewQuery): Draft => ({
  status: q.status,
  assignedAgent: q.assignedAgent ?? "",
  createdFrom: q.createdFrom?.slice(0, 10) ?? "",
  createdTo: q.createdTo?.slice(0, 10) ?? "",
  priorityMin: q.priorityMin?.toString() ?? "",
  priorityMax: q.priorityMax?.toString() ?? "",
  tags: q.tags.join(", "),
  payload: q.payload,
})

const optionalInt = (v: string) =>
  /^\s*-?\d+\s*$/.test(v) ? Number(v) : undefined

/**
 * Item filter form. Applying pushes a new URL (shareable, back-button
 * friendly); the server page re-renders from `searchParams`. The page keys
 * this component by the query string so it re-syncs on back/forward.
 */
export function ItemFilters({
  pathname,
  query,
}: {
  pathname: string
  query: TubeViewQuery
}) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()
  const [draft, setDraft] = React.useState(() => toDraft(query))
  const advancedCount = activeFilterCount({ ...query, status: [] })
  const [open, setOpen] = React.useState(advancedCount > 0)
  const count = activeFilterCount(query)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  function navigate(href: string) {
    startTransition(() => router.push(href, { scroll: false }))
  }

  function toggleStatus(status: ItemStatus) {
    const next = draft.status.includes(status)
      ? draft.status.filter((s) => s !== status)
      : ITEM_STATUSES.filter((s) => s === status || draft.status.includes(s))
    set("status", next)
    // Status chips apply immediately (together with any edited fields).
    navigate(hrefFor({ ...draft, status: next }))
  }

  function hrefFor(d: Draft): string {
    const createdFrom = d.createdFrom || undefined
    const createdTo = d.createdTo || undefined
    return tubeViewHref(pathname, query, {
      status: d.status,
      assignedAgent: d.assignedAgent.trim() || undefined,
      // keep a full ISO datetime from a shared URL unless the date changed
      createdFrom:
        createdFrom && query.createdFrom?.startsWith(createdFrom)
          ? query.createdFrom
          : createdFrom,
      createdTo:
        createdTo && query.createdTo?.startsWith(createdTo)
          ? query.createdTo
          : createdTo,
      priorityMin: optionalInt(d.priorityMin),
      priorityMax: optionalInt(d.priorityMax),
      tags: [
        ...new Set(
          d.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        ),
      ],
      payload: d.payload
        .map((row) => ({ ...row, path: row.path.trim() }))
        .filter((row) => row.path && (row.value !== "" || row.op === "exists")),
    })
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    navigate(hrefFor(draft))
  }

  function reset() {
    navigate(
      tubeViewHref(pathname, { ...EMPTY_TUBE_VIEW_QUERY, limit: query.limit })
    )
  }

  function updateRow(index: number, patch: Partial<PayloadFilterRow>) {
    set(
      "payload",
      draft.payload.map((row, i) => (i === index ? { ...row, ...patch } : row))
    )
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 border bg-card p-3"
      aria-label="Item filters"
      aria-busy={pending}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {ITEM_STATUSES.map((status) => {
          const on = draft.status.includes(status)
          return (
            <Button
              key={status}
              type="button"
              size="xs"
              variant={on ? "secondary" : "ghost"}
              aria-pressed={on}
              className={cn(on && "ring-1 ring-foreground/20")}
              onClick={() => toggleStatus(status)}
            >
              <StatusDot status={status} />
              {ITEM_STATUS_META[status].label}
            </Button>
          )
        })}
        <div className="ml-auto flex items-center gap-1.5">
          {pending && (
            <Loader2Icon
              className="size-3.5 animate-spin text-muted-foreground"
              aria-label="Loading"
            />
          )}
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-expanded={open}
            aria-controls="item-filter-fields"
            onClick={() => setOpen((o) => !o)}
          >
            <FilterIcon />
            More filters
            {advancedCount > 0 && (
              <Badge variant="secondary" className="h-4 px-1">
                {advancedCount}
              </Badge>
            )}
          </Button>
          {count > 0 && (
            <Button type="button" size="xs" variant="ghost" onClick={reset}>
              <RotateCcwIcon />
              Clear
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div id="item-filter-fields" className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <FilterField
              label="Agent"
              htmlFor="f-agent"
              className="col-span-2 md:col-span-1"
            >
              <Input
                id="f-agent"
                value={draft.assignedAgent}
                onChange={(e) => set("assignedAgent", e.target.value)}
                placeholder="agent id"
              />
            </FilterField>
            <FilterField label="Created from" htmlFor="f-from">
              <Input
                id="f-from"
                type="date"
                value={draft.createdFrom}
                onChange={(e) => set("createdFrom", e.target.value)}
              />
            </FilterField>
            <FilterField label="Created to" htmlFor="f-to">
              <Input
                id="f-to"
                type="date"
                value={draft.createdTo}
                onChange={(e) => set("createdTo", e.target.value)}
              />
            </FilterField>
            <FilterField label="Priority ≥" htmlFor="f-pmin">
              <Input
                id="f-pmin"
                type="number"
                step={1}
                value={draft.priorityMin}
                onChange={(e) => set("priorityMin", e.target.value)}
              />
            </FilterField>
            <FilterField label="Priority ≤" htmlFor="f-pmax">
              <Input
                id="f-pmax"
                type="number"
                step={1}
                value={draft.priorityMax}
                onChange={(e) => set("priorityMax", e.target.value)}
              />
            </FilterField>
            <FilterField
              label="Tags (all of)"
              htmlFor="f-tags"
              className="col-span-2 md:col-span-1"
            >
              <Input
                id="f-tags"
                value={draft.tags}
                onChange={(e) => set("tags", e.target.value)}
                placeholder="vip, eu"
              />
            </FilterField>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-[0.7rem] text-muted-foreground">
              Payload fields
            </legend>
            {draft.payload.map((row, index) => (
              <div
                key={index}
                className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5"
              >
                <Input
                  aria-label="Payload path"
                  value={row.path}
                  onChange={(e) => updateRow(index, { path: e.target.value })}
                  placeholder="customer.city"
                  className="font-mono"
                />
                <NativeSelect
                  aria-label="Operator"
                  value={row.op}
                  onChange={(e) =>
                    updateRow(index, {
                      op: e.target.value as PayloadFilterOperator,
                    })
                  }
                >
                  {PAYLOAD_FILTER_OPERATORS.map((op) => (
                    <NativeSelectOption key={op} value={op}>
                      {OPERATOR_LABELS[op]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <Input
                  aria-label="Value"
                  value={row.value}
                  onChange={(e) => updateRow(index, { value: e.target.value })}
                  placeholder={VALUE_PLACEHOLDER[row.op] ?? "value"}
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove condition"
                  onClick={() =>
                    set(
                      "payload",
                      draft.payload.filter((_, i) => i !== index)
                    )
                  }
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() =>
                  set("payload", [
                    ...draft.payload,
                    { path: "", op: "eq", value: "" },
                  ])
                }
              >
                <PlusIcon />
                Add payload condition
              </Button>
            </div>
          </fieldset>

          <div className="flex justify-end gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              Apply filters
            </Button>
          </div>
        </div>
      )}
    </form>
  )
}

function FilterField({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string
  htmlFor: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-[0.7rem] text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}
