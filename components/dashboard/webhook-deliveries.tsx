"use client"

import { EyeIcon, InboxIcon, RotateCcwIcon } from "lucide-react"
import Link from "next/link"
import * as React from "react"
import { toast } from "sonner"

import { retryWebhookDeliveryAction } from "@/app/dashboard/webhooks/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { webhooksHref, type WebhooksQuery } from "@/lib/dashboard/webhooks"
import {
  WEBHOOK_DELIVERY_STATUSES,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
} from "@mcpocket/core/domain/schemas"
import { cn } from "@/lib/utils"

import { JsonView } from "./json-editor"
import { UtcTime } from "./utc-time"

const STATUS_VARIANT: Record<
  WebhookDeliveryStatus,
  "secondary" | "default" | "destructive"
> = {
  pending: "secondary",
  delivered: "default",
  dead: "destructive",
}

export function DeliveryStatusBadge({
  status,
}: {
  status: WebhookDeliveryStatus
}) {
  return (
    <Badge variant={STATUS_VARIANT[status]} data-delivery-status={status}>
      {status}
    </Badge>
  )
}

/** Delivery log / outbox (ticket 17): newest first, filter by webhook and status. */
export function WebhookDeliveries({
  deliveries,
  total,
  webhooks,
  query,
}: {
  deliveries: WebhookDelivery[]
  total: number
  webhooks: { id: string; name: string }[]
  query: WebhooksQuery
}) {
  const [open, setOpen] = React.useState<WebhookDelivery | null>(null)
  const names = new Map(webhooks.map((w) => [w.id, w.name]))
  const filtered = query.webhook ? names.get(query.webhook) : null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          Deliveries{filtered ? ` — ${filtered}` : ""}{" "}
          <span className="text-xs font-normal text-muted-foreground">
            (
            {deliveries.length < total
              ? `latest ${deliveries.length} of ${total}`
              : total}
            )
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-1">
          {query.webhook && (
            <Button
              size="xs"
              variant="outline"
              render={<Link href={webhooksHref(query, { webhook: null })} />}
            >
              All webhooks
            </Button>
          )}
          {[null, ...WEBHOOK_DELIVERY_STATUSES].map((status) => (
            <Button
              key={status ?? "all"}
              size="xs"
              variant={query.status === status ? "default" : "outline"}
              render={<Link href={webhooksHref(query, { status })} />}
            >
              {status ?? "any status"}
            </Button>
          ))}
        </div>
      </div>

      {deliveries.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>No deliveries</EmptyTitle>
            <EmptyDescription>
              Deliveries appear here when a subscribed item event happens.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Webhook</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Last result / next attempt</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((d) => (
                <TableRow key={d.id} data-delivery-id={d.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    <UtcTime iso={d.createdAt} seconds />
                  </TableCell>
                  <TableCell className="text-xs">
                    {names.get(d.webhookId) ?? d.webhookId.slice(0, 8)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {d.eventType}
                  </TableCell>
                  <TableCell>
                    <DeliveryStatusBadge status={d.status} />
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {d.attempts}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-xs">
                    <DeliverySummary delivery={d} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Details"
                        onClick={() => setOpen(d)}
                      >
                        <EyeIcon />
                      </Button>
                      <RetryButton delivery={d} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={open !== null}
        onOpenChange={(o) => {
          if (!o) setOpen(null)
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          {open && (
            <DeliveryDetails
              delivery={open}
              webhookName={names.get(open.webhookId)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DeliverySummary({ delivery: d }: { delivery: WebhookDelivery }) {
  const last = d.attemptLog.at(-1)
  if (d.status === "delivered") {
    return (
      <span className="text-muted-foreground">
        {last?.statusCode ?? "ok"} ·{" "}
        {d.deliveredAt ? <UtcTime iso={d.deliveredAt} seconds /> : null}
      </span>
    )
  }
  return (
    <span
      className={cn(d.lastError && "text-destructive")}
      title={d.lastError ?? ""}
    >
      {d.lastError ?? "queued"}
      {d.nextAttemptAt && (
        <span className="text-muted-foreground">
          {" "}
          · next <UtcTime iso={d.nextAttemptAt} seconds />
        </span>
      )}
    </span>
  )
}

function RetryButton({ delivery }: { delivery: WebhookDelivery }) {
  const [pending, startTransition] = React.useTransition()
  const label = delivery.status === "delivered" ? "Redeliver" : "Retry now"
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await retryWebhookDeliveryAction(delivery.id)
          if (result.ok) toast.success("Delivery re-queued")
          else toast.error(result.error.message)
        })
      }
    >
      <RotateCcwIcon />
    </Button>
  )
}

function DeliveryDetails({
  delivery: d,
  webhookName,
}: {
  delivery: WebhookDelivery
  webhookName?: string
}) {
  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <code>{d.eventType}</code> <DeliveryStatusBadge status={d.status} />
        </DialogTitle>
        <DialogDescription>
          Delivery <code>{d.id}</code> to {webhookName ?? d.webhookId} · event{" "}
          <code>{d.eventId}</code>
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1">
        <h3 className="text-xs font-medium">Attempts ({d.attempts})</h3>
        {d.attemptLog.length === 0 ? (
          <p className="text-xs text-muted-foreground">Not attempted yet.</p>
        ) : (
          <div className="max-h-48 overflow-auto border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>At</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">ms</TableHead>
                  <TableHead>Response / error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...d.attemptLog].reverse().map((a, i) => (
                  <TableRow key={`${a.at}:${i}`}>
                    <TableCell className="text-xs">
                      <UtcTime iso={a.at} seconds />
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-xs",
                        a.ok ? "text-foreground" : "text-destructive"
                      )}
                    >
                      {a.statusCode ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {a.durationMs}
                    </TableCell>
                    <TableCell
                      className="max-w-72 truncate font-mono text-xs"
                      title={a.error ?? a.responseBody ?? ""}
                    >
                      {a.error ?? a.responseBody ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
      <div className="grid gap-1">
        <h3 className="text-xs font-medium">Payload</h3>
        <JsonView value={d.payload} />
      </div>
    </div>
  )
}
