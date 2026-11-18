"use server"

import { getUserServices } from "@/lib/auth/server"
import type { ActionResult } from "@/lib/dashboard/explorer"
import { tubeItemsListInput } from "@/lib/dashboard/tube-items"
import {
  parseTubeViewQuery,
  PREVIEW_BATCH_SIZE,
} from "@/lib/dashboard/tube-query"
import type { PageResult } from "@mcpocket/core/domain/pagination"
import type { Item } from "@mcpocket/core/domain/schemas"
import { normalizeError } from "@mcpocket/core/services/errors"

/**
 * Next batch of the tube preview: `search` is the view's filter query string
 * (same format as the tube view URL), `offset` the number of items already
 * shown. Read-only, so no revalidation.
 */
export async function loadPreviewItemsAction(
  tubeId: string,
  search: string,
  offset: number
): Promise<ActionResult<PageResult<Item>>> {
  const services = await getUserServices()
  try {
    const input = tubeItemsListInput(
      parseTubeViewQuery(new URLSearchParams(search))
    )
    const data = await services.items.list(tubeId, {
      ...input,
      offset: Math.max(0, Math.trunc(offset) || 0),
      limit: PREVIEW_BATCH_SIZE,
    })
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: normalizeError(error) }
  }
}
