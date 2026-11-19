"use server"

import type { ActionResult } from "@/lib/dashboard/explorer"
import {
  loadSharedItems,
  parseFeedQuery,
  shareAccess,
} from "@/lib/share/server"
import type { SharedItemsPage } from "@/lib/share/types"
import { normalizeError } from "@mcpocket/core/services/errors"

/**
 * Next batch of a public tube feed. `secret` is the page's `?api_key=`:
 * authenticated (and rate limited) again on every call.
 */
export async function loadSharedItemsAction(
  secret: string,
  tubeId: string,
  query: { status?: string; order?: string },
  offset: number
): Promise<ActionResult<SharedItemsPage>> {
  const access = await shareAccess(secret)
  if (!access.ok) {
    return {
      ok: false,
      error: {
        code:
          access.reason === "rate_limited" ? "rate_limited" : "unauthorized",
        message:
          access.reason === "rate_limited"
            ? "Too many requests, try again in a minute"
            : "This link is no longer valid",
      },
    }
  }
  try {
    const data = await loadSharedItems(
      access.services,
      tubeId,
      parseFeedQuery(query),
      offset
    )
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: normalizeError(error) }
  }
}
