import { ScrollTextIcon } from "lucide-react"

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
import { historyDiff, previewJson } from "@/lib/dashboard/history-diff"
import type { AuditEvent } from "@mcpocket/core/domain/schemas"

import { UtcTime } from "./utc-time"

const ACTION_LABELS: Record<string, string> = {
  "api_key.created": "Key created",
  "api_key.updated": "Permissions changed",
  "api_key.secret_rotated": "Secret rotated",
  "api_key.revoked": "Key revoked",
  "api_key.deleted": "Key deleted",
}

/** Access audit log (key and permission changes), newest first. */
export function AccessAuditLog({
  events,
  total,
}: {
  events: AuditEvent[]
  total: number
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Access audit log</h2>
      {events.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollTextIcon />
            </EmptyMedia>
            <EmptyTitle>No changes yet</EmptyTitle>
            <EmptyDescription>
              Key creation, permission changes, rotations and revocations appear
              here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When (UTC)</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id} data-audit-action={event.action}>
                  <TableCell className="text-xs">
                    <UtcTime iso={event.createdAt} seconds />
                  </TableCell>
                  <TableCell className="text-xs">
                    {ACTION_LABELS[event.action] ?? event.action}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {event.targetId}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {event.actor}
                  </TableCell>
                  <TableCell className="max-w-96 text-xs whitespace-normal">
                    <ul className="flex flex-col gap-0.5">
                      {historyDiff(event.oldValue, event.newValue).map(
                        (row) => (
                          <li key={row.field} className="break-all">
                            <span className="text-muted-foreground">
                              {row.field || "value"}:
                            </span>{" "}
                            {row.kind !== "added" && (
                              <span className="line-through opacity-60">
                                {previewJson(row.oldValue, 60)}
                              </span>
                            )}
                            {row.kind === "changed" && " → "}
                            {row.kind !== "removed" &&
                              previewJson(row.newValue, 60)}
                          </li>
                        )
                      )}
                    </ul>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {total > events.length && (
        <p className="text-xs text-muted-foreground">
          Showing the {events.length} most recent of {total} entries (full log:{" "}
          <code>GET /api/audit</code>).
        </p>
      )}
    </div>
  )
}
