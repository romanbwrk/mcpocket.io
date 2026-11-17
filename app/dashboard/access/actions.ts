"use server"

import { revalidatePath } from "next/cache"

import { getUserServices } from "@/lib/auth/server"
import type { ActionResult } from "@/lib/dashboard/explorer"
import type { Services } from "@mcpocket/core/services"
import type {
  ApiKeyView,
  ApiKeyWithSecret,
} from "@mcpocket/core/services/api-keys"
import { normalizeError } from "@mcpocket/core/services/errors"

/**
 * API key / permission management (ticket 16). Same pattern as
 * app/dashboard/actions.ts: session check → the admin's services (which
 * enforce `access:manage` and write the audit log) → ActionResult.
 * Secrets are returned by create/rotate; only keys created with
 * `secretVisibility: "always"` keep theirs for `revealApiKeySecretAction`.
 */
async function run<T>(
  fn: (services: Services) => Promise<T>
): Promise<ActionResult<T>> {
  const services = await getUserServices()
  try {
    const data = await fn(services)
    revalidatePath("/dashboard/access")
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: normalizeError(error) }
  }
}

/** `{ id, role, description?, scope?, agentId?, rateLimitPerMinute? }` → key + one-time secret. */
export async function createApiKeyAction(
  input: unknown
): Promise<ActionResult<ApiKeyWithSecret>> {
  return run((s) => s.apiKeys.create(input))
}

/** `{ description?, role?, scope?, agentId?, rateLimitPerMinute? }` (null clears). */
export async function updateApiKeyAction(
  id: string,
  input: unknown
): Promise<ActionResult<ApiKeyView>> {
  return run((s) => s.apiKeys.update(id, input))
}

export async function rotateApiKeyAction(
  id: string
): Promise<ActionResult<ApiKeyWithSecret>> {
  return run((s) => s.apiKeys.rotate(id))
}

/** Clear-text secret of a key created with `secretVisibility: "always"`. */
export async function revealApiKeySecretAction(
  id: string
): Promise<ActionResult<string>> {
  return run((s) => s.apiKeys.revealSecret(id))
}

export async function revokeApiKeyAction(
  id: string
): Promise<ActionResult<ApiKeyView>> {
  return run((s) => s.apiKeys.revoke(id))
}

export async function deleteApiKeyAction(
  id: string
): Promise<ActionResult<undefined>> {
  return run(async (s) => {
    await s.apiKeys.delete(id)
    return undefined
  })
}
