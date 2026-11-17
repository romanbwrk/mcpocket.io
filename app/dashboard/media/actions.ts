"use server"

import { revalidatePath } from "next/cache"

import { getUserServices } from "@/lib/auth/server"
import type { ActionResult } from "@/lib/dashboard/explorer"
import { ValidationError } from "@mcpocket/core/domain/errors"
import type { MediaObject } from "@mcpocket/core/media"
import type { Services } from "@mcpocket/core/services"
import { normalizeError } from "@mcpocket/core/services/errors"
import type { MediaUsage } from "@mcpocket/core/services/media"

/**
 * Media library actions: session check → the user's services (same rules as
 * REST `/api/media*`) → ActionResult.
 */
async function run<T>(
  fn: (services: Services) => Promise<T>,
  revalidate = true
): Promise<ActionResult<T>> {
  const services = await getUserServices()
  try {
    const data = await fn(services)
    if (revalidate) revalidatePath("/dashboard/media")
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: normalizeError(error) }
  }
}

/** One file per call (`file` field), so each upload reports on its own. */
export async function uploadMediaAction(
  form: FormData
): Promise<ActionResult<MediaObject>> {
  return run(async (s) => {
    const file = form.get("file")
    if (!(file instanceof File) || file.size === 0) {
      throw new ValidationError("Choose a non-empty file")
    }
    return s.media.upload({
      body: new Uint8Array(await file.arrayBuffer()),
      contentType: file.type || "application/octet-stream",
      ...(file.name && { filename: file.name }),
    })
  })
}

export async function mediaUsageAction(
  key: string
): Promise<ActionResult<MediaUsage>> {
  return run((s) => s.media.usage(key), false)
}

export async function deleteMediaAction(
  key: string
): Promise<ActionResult<{ key: string }>> {
  return run((s) => s.media.delete(key))
}
