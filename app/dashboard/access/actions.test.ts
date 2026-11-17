import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { authenticateRequest } from "@mcpocket/core/api/auth"
import {
  adminConfigFromEnv,
  createSessionToken,
  SESSION_COOKIE,
} from "@mcpocket/core/auth/session"
import { cookieJar, nextCacheMock, RedirectError } from "@/lib/auth/test-utils"
import { keyFormInput } from "@/lib/dashboard/api-keys"
import type { ActionResult } from "@/lib/dashboard/explorer"
import { getServices } from "@mcpocket/core/services"
import { resetStorageSingleton } from "@mcpocket/core/storage"

import {
  createApiKeyAction,
  deleteApiKeyAction,
  revokeApiKeyAction,
  rotateApiKeyAction,
  updateApiKeyAction,
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
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-dash-access-"))
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

const bearer = (secret: string) =>
  authenticateRequest(
    new Request("http://localhost/api", {
      headers: { authorization: `Bearer ${secret}` },
    })
  )

describe("access actions", () => {
  it("require a session", async () => {
    await expect(
      createApiKeyAction({ id: "k", role: "readonly" })
    ).rejects.toBeInstanceOf(RedirectError)
  })

  it("create → edit → rotate → revoke → delete, audited as the dashboard user", async () => {
    login()
    const admin = await getServices({ kind: "system", id: "test" })
    const folder = await admin.folders.create({ name: "F" })
    const fields = {
      id: "dash-bot",
      description: "",
      role: "agent" as const,
      scopeMode: "selected" as const,
      folderIds: [folder.id],
      tubeIds: [],
      agentId: "bot-9",
      rateLimit: "",
      secretVisibility: "once" as const,
    }
    const { key, secret } = ok(
      await createApiKeyAction(keyFormInput(fields, false))
    )
    expect(key).toMatchObject({
      id: "dash-bot",
      agentId: "bot-9",
      rateLimitPerMinute: null,
    })
    expect(nextCacheMock.revalidatePath).toHaveBeenCalledWith(
      "/dashboard/access"
    )
    expect(await bearer(secret)).toMatchObject({ kind: "agent", id: "bot-9" })

    const edited = ok(
      await updateApiKeyAction(
        "dash-bot",
        keyFormInput(
          { ...fields, role: "readonly", agentId: "", rateLimit: "10" },
          true
        )
      )
    )
    expect(edited).toMatchObject({
      role: "readonly",
      agentId: null,
      rateLimitPerMinute: 10,
    })

    const invalid = await updateApiKeyAction("dash-bot", { role: "admin" })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe("validation_error")

    const rotated = ok(await rotateApiKeyAction("dash-bot"))
    await expect(bearer(secret)).rejects.toThrow()
    expect(await bearer(rotated.secret)).toMatchObject({ id: "dash-bot" })
    expect(ok(await revokeApiKeyAction("dash-bot")).status).toBe("revoked")
    ok(await deleteApiKeyAction("dash-bot"))

    const log = await admin.apiKeys.auditLog()
    expect(log.data.map((e) => [e.action, e.actor])).toEqual([
      ["api_key.deleted", "user:boss"],
      ["api_key.revoked", "user:boss"],
      ["api_key.secret_rotated", "user:boss"],
      ["api_key.updated", "user:boss"],
      ["api_key.created", "user:boss"],
    ])
  })
})

describe("keyFormInput", () => {
  const base = {
    id: " k ",
    description: " ",
    role: "operator" as const,
    scopeMode: "all" as const,
    folderIds: ["x"],
    tubeIds: [],
    agentId: "",
    rateLimit: "",
    secretVisibility: "always" as const,
  }
  it("omits empty values on create and clears them on edit", () => {
    expect(keyFormInput(base, false)).toEqual({
      id: "k",
      secretVisibility: "always",
      role: "operator",
      scope: null,
    })
    expect(keyFormInput(base, true)).toEqual({
      role: "operator",
      scope: null,
      description: null,
      agentId: null,
      rateLimitPerMinute: null,
    })
  })
  it("sends the selected scope, never for admins", () => {
    const selected = { ...base, scopeMode: "selected" as const, rateLimit: "0" }
    expect(keyFormInput(selected, false)).toMatchObject({
      scope: { folderIds: ["x"], tubeIds: [] },
      rateLimitPerMinute: 0,
    })
    expect(keyFormInput({ ...selected, role: "admin" }, false).scope).toBeNull()
  })
})
