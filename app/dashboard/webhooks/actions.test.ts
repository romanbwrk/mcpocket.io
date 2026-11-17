import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  adminConfigFromEnv,
  createSessionToken,
  SESSION_COOKIE,
} from "@mcpocket/core/auth/session"
import { cookieJar, nextCacheMock, RedirectError } from "@/lib/auth/test-utils"
import type { ActionResult } from "@/lib/dashboard/explorer"
import { webhookFormInput } from "@/lib/dashboard/webhooks"
import { getServices } from "@mcpocket/core/services"
import { resetStorageSingleton } from "@mcpocket/core/storage"

import {
  createWebhookAction,
  deleteWebhookAction,
  retryWebhookDeliveryAction,
  rotateWebhookSecretAction,
  testWebhookAction,
  updateWebhookAction,
} from "./actions"

vi.mock("server-only", () => ({}))
vi.mock(
  "next/headers",
  async () => (await import("@/lib/auth/test-utils")).nextHeadersMock
)
vi.mock(
  "next/navigation",
  async () => (await import("@/lib/auth/test-utils")).nextNavigationMock
)
vi.mock(
  "next/cache",
  async () => (await import("@/lib/auth/test-utils")).nextCacheMock
)

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-dash-webhooks-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_ADMIN_USERNAME", "boss")
  vi.stubEnv("MCPOCKET_ADMIN_PASSWORD", "pw-123456")
  vi.stubEnv("MCPOCKET_SESSION_SECRET", "s".repeat(40))
  await resetStorageSingleton()
  cookieJar.clear()
  nextCacheMock.revalidatePath.mockClear()
})
afterEach(async () => {
  await resetStorageSingleton()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

function login() {
  const { token } = createSessionToken(adminConfigFromEnv())
  cookieJar.set(SESSION_COOKIE, { value: token })
}

function ok<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.data
}

describe("webhook actions", () => {
  it("require a session", async () => {
    await expect(
      createWebhookAction({ name: "x", url: "https://x.test" })
    ).rejects.toBeInstanceOf(RedirectError)
  })

  it("create, edit, test, retry, rotate and delete as the dashboard user", async () => {
    login()
    const { webhook, secret } = ok(
      await createWebhookAction(
        webhookFormInput({
          name: "CRM",
          url: "https://crm.example.com/h",
          eventTypes: ["item.created"],
          scope: "",
          enabled: true,
        })
      )
    )
    expect(secret).toMatch(/^whsec_/)
    expect(nextCacheMock.revalidatePath).toHaveBeenCalledWith(
      "/dashboard/webhooks"
    )

    const invalid = await updateWebhookAction(webhook.id, { url: "nope" })
    expect(invalid.ok).toBe(false)

    const delivery = ok(await testWebhookAction(webhook.id))
    expect(delivery).toMatchObject({
      eventType: "webhook.ping",
      status: "pending",
    })
    expect(ok(await retryWebhookDeliveryAction(delivery.id))).toMatchObject({
      status: "pending",
    })
    expect(ok(await rotateWebhookSecretAction(webhook.id)).secret).not.toBe(
      secret
    )
    ok(await deleteWebhookAction(webhook.id))

    const services = await getServices({ kind: "system", id: "test" })
    const audit = await services.apiKeys.auditLog({ targetType: "webhook" })
    expect(audit.data.map((e) => [e.action, e.actor])).toEqual([
      ["webhook.deleted", "user:boss"],
      ["webhook.secret_rotated", "user:boss"],
      ["webhook.delivery_retried", "user:boss"],
      ["webhook.created", "user:boss"],
    ])
  })
})
