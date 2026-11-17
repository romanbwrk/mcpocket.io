import { randomBytes } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as foldersRoute from "@/app/api/folders/route"
import { authorizeMediaRequest } from "@mcpocket/core/api/media-access"
import { hashSecretHex } from "@mcpocket/core/auth/api-keys"
import {
  adminConfigFromEnv,
  createSsoSessionToken,
  SESSION_COOKIE,
} from "@mcpocket/core/auth/session"
import {
  resetSsoReplayCache,
  ssoConfigFromEnv,
  verifySsoToken,
} from "@mcpocket/core/auth/sso"
import { EventBus, workspacePublisher } from "@mcpocket/core/events/bus"
import { createEventStreamResponse } from "@mcpocket/core/events/sse"
import {
  createMemoryMediaStore,
  mediaStoreForWorkspace,
} from "@mcpocket/core/media/store"
import { getServices } from "@mcpocket/core/services"
import { getStorage, resetStorageSingleton } from "@mcpocket/core/storage"
import { connectMongo } from "@mcpocket/core/storage/mongo/mongo-storage"
import { makeApiKey, makeFolder } from "@mcpocket/core/storage/testing/contract"
import { createHmac } from "node:crypto"

/**
 * Multi-workspace mode (`MCPOCKET_MULTI_WORKSPACE=true`, MCPocket Cloud):
 * one instance, one MongoDB database, each request acting in the workspace
 * of its credential. Storage tests need `MONGODB_TEST_URI`.
 */
const URI = process.env.MONGODB_TEST_URI?.trim()
const SSO_SECRET = "s".repeat(40)

beforeEach(() => {
  vi.stubEnv("MCPOCKET_MULTI_WORKSPACE", "true")
  vi.stubEnv("MCPOCKET_WORKSPACE", "")
  vi.stubEnv("MCPOCKET_SSO_WORKSPACE", "")
  vi.stubEnv("MCPOCKET_SSO_SECRET", SSO_SECRET)
  vi.stubEnv("MCPOCKET_SEED_ON_FIRST_START", "false")
  vi.stubEnv("MCPOCKET_API_KEYS", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function ssoToken(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url")
  const now = Math.floor(Date.now() / 1000)
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub: "ada@example.com",
    jti: randomBytes(8).toString("hex"),
    iat: now,
    exp: now + 30,
    ...claims,
  })}`
  const sig = createHmac("sha256", SSO_SECRET).update(body).digest("base64url")
  return `${body}.${sig}`
}

describe("multi-workspace SSO", () => {
  beforeEach(() => resetSsoReplayCache())

  it("requires a workspace in every sign-in token", () => {
    const config = ssoConfigFromEnv()!
    expect(config.requireWorkspace).toBe(true)
    expect(verifySsoToken(config, ssoToken({}))).toEqual({
      ok: false,
      reason: "missing_workspace",
    })
    expect(verifySsoToken(config, ssoToken({ ws: "../x" }))).toEqual({
      ok: false,
      reason: "missing_workspace",
    })
    const ok = verifySsoToken(config, ssoToken({ ws: "acme" }))
    expect(ok.ok && ok.claims.ws).toBe("acme")
  })
})

describe("multi-workspace media", () => {
  it("keeps each workspace's objects under its own prefix", async () => {
    const base = createMemoryMediaStore({ prefix: "media/" })
    const acme = mediaStoreForWorkspace(base, "acme")
    const beta = mediaStoreForWorkspace(base, "beta")
    expect(acme.limits.prefix).toBe("media/acme/")
    const file = { body: new Uint8Array([1]), contentType: "image/png" }
    await acme.put({ key: "media/acme/aa/x.png", ...file })
    await beta.put({ key: "media/beta/bb/y.png", ...file })
    expect((await acme.list()).objects.map((o) => o.key)).toEqual([
      "media/acme/aa/x.png",
    ])
    expect((await beta.list()).objects.map((o) => o.key)).toEqual([
      "media/beta/bb/y.png",
    ])
  })

  it("serves a file only to a session of its workspace", async () => {
    const config = adminConfigFromEnv()
    const request = (ws: string) =>
      new Request("https://x.test/api/media/files/media/acme/aa/x.png", {
        headers: {
          cookie: `${SESSION_COOKIE}=${
            createSsoSessionToken(config, "ada@example.com", new Date(), ws)
              .token
          }`,
        },
      })
    const key = "media/acme/aa/x.png"
    const grant = (ws: string) =>
      authorizeMediaRequest(request(ws), key, "private", new Date(), "acme")
    expect(await grant("acme")).toMatchObject({ ok: true, via: "session" })
    expect(await grant("beta")).toEqual({ ok: false })
  })
})

describe("multi-workspace events", () => {
  it("streams only the subscriber's workspace", async () => {
    const bus = new EventBus()
    const abort = new AbortController()
    const response = createEventStreamResponse({
      bus,
      scope: { kind: "global" },
      workspace: "acme",
      signal: abort.signal,
    })
    const reader = response.body!.getReader()
    const event = (itemId: string) => ({
      type: "item.created" as const,
      action: "created",
      at: new Date().toISOString(),
      actor: "user:x",
      itemId,
      tubeId: "t",
      status: "pending" as const,
      assignedAgent: null,
    })
    workspacePublisher(bus, "beta").publish(event("beta-item"))
    workspacePublisher(bus, "acme").publish(event("acme-item"))
    let text = ""
    while (!text.includes("acme-item")) {
      text += new TextDecoder().decode((await reader.read()).value)
    }
    abort.abort()
    expect(text).not.toContain("beta-item")
    expect(text).toContain('"workspace":"acme"')
  })
})

describe.skipIf(!URI)(
  "multi-workspace storage (MongoDB)",
  { timeout: 30_000 },
  () => {
    let dbName: string

    beforeEach(async () => {
      dbName = `mcpocket_test_${randomBytes(6).toString("hex")}`
      vi.stubEnv("STORAGE_DRIVER", "mongo")
      vi.stubEnv("MONGODB_URI", URI!)
      vi.stubEnv("MONGODB_DB", dbName)
      await resetStorageSingleton()
    })

    afterEach(async () => {
      await resetStorageSingleton()
      const client = await connectMongo(URI!)
      try {
        await client.db(dbName).dropDatabase()
      } finally {
        await client.close()
      }
    })

    const user = (workspace: string) => ({
      kind: "user" as const,
      id: "ada@example.com",
      workspace,
    })

    it("scopes services to the actor's workspace", async () => {
      const acme = await getServices(user("acme"))
      const beta = await getServices(user("beta"))
      const folder = await acme.folders.create({ name: "Acme only" })
      expect((await acme.folders.list()).data.map((f) => f.id)).toEqual([
        folder.id,
      ])
      expect((await beta.folders.list()).data).toEqual([])
      expect((await getStorage()).listWorkspaces).toBeDefined()
      expect(await (await getStorage()).listWorkspaces!("folders")).toEqual([
        "acme",
      ])
    })

    it("refuses another workspace inside a transaction", async () => {
      const acme = await getStorage("acme")
      const beta = await getStorage("beta")
      await expect(
        acme.transaction(() => beta.folders.create(makeFolder()))
      ).rejects.toThrow(/inside a transaction of workspace "acme"/)
    })

    it("locks per workspace: one workspace's transaction never blocks another", async () => {
      const acme = await getStorage("acme")
      const beta = await getStorage("beta")
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      const acmeTx = acme.transaction(async (repos) => {
        await repos.folders.create(makeFolder({ name: "Acme" }))
        await held
      })
      // Completes while acme's transaction still holds its lock.
      await beta.folders.create(makeFolder({ name: "Beta" }))
      expect(await beta.folders.count()).toBe(1)
      // The same workspace still waits for the lock.
      let acmeWriteDone = false
      const acmeWrite = acme.folders
        .create(makeFolder({ name: "Acme 2" }))
        .then(() => (acmeWriteDone = true))
      await new Promise((r) => setTimeout(r, 50))
      expect(acmeWriteDone).toBe(false)
      release()
      await Promise.all([acmeTx, acmeWrite])
      expect(await acme.folders.count()).toBe(2)
    })

    it("authenticates a managed API key into its own workspace", async () => {
      const secret = `mcp_${randomBytes(16).toString("hex")}`
      const beta = await getStorage("beta")
      await beta.apiKeys.create(
        makeApiKey({ role: "admin", secretHash: hashSecretHex(secret) })
      )
      await beta.folders.create(makeFolder({ name: "Beta folder" }))
      await (
        await getStorage("acme")
      ).folders.create(makeFolder({ name: "Acme folder" }))

      const response = await foldersRoute.GET(
        new Request("https://x.test/api/folders", {
          headers: { authorization: `Bearer ${secret}` },
        })
      )
      expect(response.status).toBe(200)
      const body = await response.json()
      const names = (body.data ?? body).map((f: { name: string }) => f.name)
      expect(names).toEqual(["Beta folder"])
    })

    it("seeds an empty workspace on first use when enabled", async () => {
      vi.stubEnv("MCPOCKET_SEED_ON_FIRST_START", "true")
      const fresh = await getStorage(`ws-${randomBytes(3).toString("hex")}`)
      expect(await fresh.folders.count()).toBeGreaterThan(0)
      expect(await (await getStorage("other")).folders.count()).toBeGreaterThan(
        0
      )
    })
  }
)
