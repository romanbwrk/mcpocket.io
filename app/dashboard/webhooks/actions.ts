"use server"

import { revalidatePath } from "next/cache"

import { getUserServices } from "@/lib/auth/server"
import type { ActionResult } from "@/lib/dashboard/explorer"
import type { WebhookDelivery } from "@mcpocket/core/domain/schemas"
import type { Services } from "@mcpocket/core/services"
import { normalizeError } from "@mcpocket/core/services/errors"
import type { WebhookView, WebhookWithSecret } from "@mcpocket/core/services/webhooks"

/**
 * Webhook management (ticket 17). Same pattern as the access page: session
 * check → the admin's services (`access:manage`, audited) → ActionResult.
 * Signing secrets are returned once by create / rotate.
 */
async function run<T>(
  fn: (services: Services) => Promise<T>
): Promise<ActionResult<T>> {
  const services = await getUserServices()
  try {
    const data = await fn(services)
    revalidatePath("/dashboard/webhooks")
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: normalizeError(error) }
  }
}

/** `{ name, url, eventTypes?, folderId?, tubeId?, enabled? }` → webhook + one-time secret. */
export async function createWebhookAction(
  input: unknown
): Promise<ActionResult<WebhookWithSecret>> {
  return run((s) => s.webhooks.create(input))
}

/** `{ name?, url?, eventTypes?, folderId?, tubeId?, enabled? }` (null clears scope). */
export async function updateWebhookAction(
  id: string,
  input: unknown
): Promise<ActionResult<WebhookView>> {
  return run((s) => s.webhooks.update(id, input))
}

export async function rotateWebhookSecretAction(
  id: string
): Promise<ActionResult<WebhookWithSecret>> {
  return run((s) => s.webhooks.rotateSecret(id))
}

export async function deleteWebhookAction(
  id: string
): Promise<ActionResult<undefined>> {
  return run(async (s) => {
    await s.webhooks.delete(id)
    return undefined
  })
}

/** Queues a `webhook.ping` delivery. */
export async function testWebhookAction(
  id: string
): Promise<ActionResult<WebhookDelivery>> {
  return run((s) => s.webhooks.test(id))
}

/** Re-queues a delivery now with a fresh attempt budget. */
export async function retryWebhookDeliveryAction(
  id: string
): Promise<ActionResult<WebhookDelivery>> {
  return run((s) => s.webhooks.retryDelivery(id))
}
