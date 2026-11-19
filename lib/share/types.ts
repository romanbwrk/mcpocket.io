import type { ItemStatus } from "@mcpocket/core/domain/schemas"
import type { MediaKind } from "@mcpocket/core/media/kinds"

/** Client-safe DTOs of the public share pages (see `lib/share/server.ts`). */

export type ShareFeedQuery = {
  status?: ItemStatus
  order: "asc" | "desc"
}

/** A media URL found in an item (signed when it's this server's private media). */
export type SharedMedia = {
  /** Where in the item, e.g. `result.video` or `payload.images[0]`. */
  path: string
  url: string
  kind: MediaKind
  /** Image / video / audio: rendered inline. */
  previewable: boolean
}

export type SharedItem = {
  id: string
  status: ItemStatus
  tags: string[]
  createdAt: string
  updatedAt: string
  payload: unknown
  result?: unknown
  metadata: Record<string, unknown>
  media: SharedMedia[]
  /** Last error message, if any. */
  error?: string
}

export type SharedItemsPage = { items: SharedItem[]; total: number }
