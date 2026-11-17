"use client"

import { cn } from "cn"
import { RotateCcwIcon } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { resetTubeAction } from "@/app/dashboard/actions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { ITEM_STATUSES, type ItemStatus } from "@mcpocket/core/domain/schemas"
import type { StatusCounts } from "@mcpocket/core/services/statistics"

import { ActionError } from "./action-error"
import { ITEM_STATUS_META, StatusDot } from "./item-status"
import { useServerAction } from "./use-server-action"

const PRESETS: { label: string; status: readonly ItemStatus[] }[] = [
  { label: "Failed", status: ["failed"] },
  { label: "Failed + cancelled", status: ["failed", "cancelled"] },
  {
    label: "Unfinished",
    status: ["processing", "failed", "retry", "cancelled"],
  },
  { label: "All", status: ITEM_STATUSES },
]

const sameSet = (a: readonly ItemStatus[], b: readonly ItemStatus[]) =>
  a.length === b.length && a.every((s) => b.includes(s))

/**
 * "Reset" button + dialog: pick which statuses to reset (presets: failed
 * only, failed + cancelled, unfinished, all), then requeue the matching items
 * as fresh `pending` items (`items.requeueAll`) so agents process them again.
 * `counts` (tube statistics) shows how many items each status holds.
 */
export function ResetTubeButton({
  tubeId,
  tubeName,
  counts,
}: {
  tubeId: string
  tubeName: string
  counts?: StatusCounts | null
}) {
  const [open, setOpen] = React.useState(false)
  const [selected, setSelected] = React.useState<readonly ItemStatus[]>([
    "failed",
  ])
  const { pending, error, run, setError } = useServerAction()

  const all = sameSet(selected, ITEM_STATUSES)
  const affected = counts
    ? selected.reduce((sum, s) => sum + counts[s], 0)
    : null

  function toggle(status: ItemStatus) {
    setSelected((prev) =>
      prev.includes(status)
        ? prev.filter((s) => s !== status)
        : ITEM_STATUSES.filter((s) => s === status || prev.includes(s))
    )
  }

  function reset() {
    run(
      // all statuses → no filter, so items of any (future) status are included
      () => resetTubeAction(tubeId, all ? {} : { status: [...selected] }),
      ({ matched, requeued }) => {
        const n = `${matched} matching item${matched === 1 ? "" : "s"}`
        toast.success(
          matched === 0
            ? "No items match the selected statuses"
            : requeued === 0
              ? `All ${n} ${matched === 1 ? "is" : "are"} already pending`
              : `Requeued ${requeued} of ${n}`
        )
        setOpen(false)
      }
    )
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setError(null)
      }}
    >
      <AlertDialogTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            title="Requeue items as pending (pick statuses)"
          />
        }
      >
        <RotateCcwIcon />
        Reset
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset “{tubeName}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Items with the selected statuses go back to <strong>pending</strong>{" "}
            so agents process them again: assignments and active leases are
            revoked, and attempts, results and errors are cleared. Payloads,
            tags and priorities are kept, and each item&apos;s history records
            the reset.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-muted-foreground">Quick:</span>
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                size="xs"
                variant="outline"
                aria-pressed={sameSet(selected, preset.status)}
                className={cn(
                  sameSet(selected, preset.status) && "bg-secondary"
                )}
                onClick={() => setSelected(preset.status)}
                disabled={pending}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div
            role="group"
            aria-label="Statuses to reset"
            className="flex flex-wrap gap-1.5"
          >
            {ITEM_STATUSES.map((status) => {
              const on = selected.includes(status)
              return (
                <Button
                  key={status}
                  type="button"
                  size="xs"
                  variant={on ? "secondary" : "ghost"}
                  aria-pressed={on}
                  className={cn(on && "ring-1 ring-foreground/20")}
                  onClick={() => toggle(status)}
                  disabled={pending}
                >
                  <StatusDot status={status} />
                  {ITEM_STATUS_META[status].label}
                  {counts && (
                    <span className="text-muted-foreground tabular-nums">
                      {counts[status]}
                    </span>
                  )}
                </Button>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {selected.length === 0
              ? "Select at least one status."
              : affected === null
                ? `${selected.length} status${selected.length === 1 ? "" : "es"} selected.`
                : `${affected} item${affected === 1 ? "" : "s"} selected${
                    selected.includes("pending")
                      ? " (untouched pending items are left as is)"
                      : ""
                  }.`}
          </p>
        </div>

        <ActionError error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending || selected.length === 0 || affected === 0}
            onClick={reset}
          >
            {pending
              ? "Resetting…"
              : all
                ? "Reset all items"
                : affected === null
                  ? "Reset items"
                  : `Reset ${affected} item${affected === 1 ? "" : "s"}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
