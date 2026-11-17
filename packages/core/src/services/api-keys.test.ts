import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { authenticateRequest } from "../api/auth"
import { hashSecretHex } from "../auth/api-keys"
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../domain/errors"
import { EventBus } from "../events/bus"
import { createServiceContext, createServices, type Services } from "./index"
import type { Storage } from "../storage"
import { createJsonStorage } from "../storage/json/json-storage"

let dataDir: string
let storage: Storage
let admin: Services

beforeEach(async () => {
  vi.stubEnv("MCPOCKET_API_KEYS", "envkey:env-secret")
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-keys-"))
  storage = await createJsonStorage({ dataDir })
  admin = createServices(
    createServiceContext(storage, { events: new EventBus() }),
    { kind: "user", id: "admin", access: { role: "admin", scope: null } }
  )
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await storage.close()
  await rm(dataDir, { recursive: true, force: true })
})

const auth = (secret: string) =>
  authenticateRequest(
    new Request("http://localhost/api", {
      headers: { authorization: `Bearer ${secret}` },
    }),
    { managedKeys: () => storage.apiKeys.list() }
  )

describe("API key service", () => {
  it("creates a key whose secret is shown once and stored hashed", async () => {
    const folder = await admin.folders.create({ name: "f" })
    const { key, secret } = await admin.apiKeys.create({
      id: "ingest-bot",
      role: "agent",
      description: "Ingest",
      scope: { folderIds: [folder.id, folder.id] },
      agentId: "ingest-1",
      rateLimitPerMinute: 30,
    })
    expect(secret).toMatch(/^mcp_[A-Za-z0-9_-]{40,}$/)
    expect(key).toMatchObject({
      id: "ingest-bot",
      source: "managed",
      role: "agent",
      scope: { folderIds: [folder.id], tubeIds: [] },
      agentId: "ingest-1",
      rateLimitPerMinute: 30,
      status: "active",
      createdBy: "user:admin",
      secretPrefix: secret.slice(0, 8),
    })
    expect(JSON.stringify(key)).not.toContain(secret)
    expect(key).not.toHaveProperty("secretHash")

    const file = await readFile(path.join(dataDir, "api-keys.json"), "utf8")
    expect(file).not.toContain(secret)
    expect(file).toContain(hashSecretHex(secret))

    expect(await auth(secret)).toEqual({
      kind: "agent",
      id: "ingest-1",
      viaKeyId: "ingest-bot",
      access: { role: "agent", scope: { folderIds: [folder.id], tubeIds: [] } },
    })

    const list = await admin.apiKeys.list()
    expect(list.map((k) => [k.id, k.source, k.role])).toEqual([
      ["envkey", "env", "admin"],
      ["ingest-bot", "managed", "agent"],
    ])
    expect(JSON.stringify(list)).not.toMatch(/secretHash|env-secret/)
  })

  it("keeps the secret of show-each-time keys for revealSecret", async () => {
    const once = await admin.apiKeys.create({ id: "once", role: "agent" })
    expect(once.key.secretVisibility).toBe("once")
    await expect(admin.apiKeys.revealSecret("once")).rejects.toThrow(
      ConflictError
    )
    await expect(admin.apiKeys.revealSecret("envkey")).rejects.toThrow(
      ConflictError
    )

    const { key, secret } = await admin.apiKeys.create({
      id: "viewable",
      role: "agent",
      secretVisibility: "always",
    })
    expect(key.secretVisibility).toBe("always")
    expect(await admin.apiKeys.revealSecret("viewable")).toBe(secret)
    expect(JSON.stringify(await admin.apiKeys.list())).not.toContain(secret)

    const rotated = await admin.apiKeys.rotate("viewable")
    expect(await admin.apiKeys.revealSecret("viewable")).toBe(rotated.secret)
    expect(await auth(rotated.secret)).toMatchObject({ id: "viewable" })
    await expect(admin.apiKeys.revealSecret("nope")).rejects.toThrow(
      NotFoundError
    )
  })

  it("validates ids, roles and scopes", async () => {
    await expect(
      admin.apiKeys.create({ id: "envkey", role: "readonly" })
    ).rejects.toThrow(ConflictError)
    await admin.apiKeys.create({ id: "k1", role: "readonly" })
    await expect(
      admin.apiKeys.create({ id: "k1", role: "readonly" })
    ).rejects.toThrow(ConflictError)
    await expect(
      admin.apiKeys.create({ id: "bad id", role: "readonly" })
    ).rejects.toThrow()
    await expect(
      admin.apiKeys.create({ id: "k2", role: "root" })
    ).rejects.toThrow()
    await expect(
      admin.apiKeys.create({
        id: "k3",
        role: "operator",
        scope: { folderIds: [], tubeIds: [] },
      })
    ).rejects.toThrow(ValidationError)
    const err = await admin.apiKeys
      .create({
        id: "k4",
        role: "operator",
        scope: { tubeIds: ["00000000-0000-4000-8000-000000000009"] },
      })
      .catch((e) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.details).toEqual([
      { path: "scope.tubeIds.0", message: "Unknown tube" },
    ])
    await expect(
      admin.apiKeys.update("envkey", { role: "readonly" })
    ).rejects.toThrow(ConflictError)
    await expect(admin.apiKeys.delete("nope")).rejects.toThrow(NotFoundError)
  })

  it("updates, rotates, revokes and deletes — all audit-logged", async () => {
    const t = await admin.tubes.create({
      folderId: (await admin.folders.create({ name: "f" })).id,
      name: "t",
    })
    const { secret } = await admin.apiKeys.create({ id: "k", role: "agent" })

    const updated = await admin.apiKeys.update("k", {
      role: "readonly",
      scope: { tubeIds: [t.id] },
    })
    expect(updated).toMatchObject({
      role: "readonly",
      scope: { folderIds: [], tubeIds: [t.id] },
    })
    // no-op update writes nothing
    await admin.apiKeys.update("k", { role: "readonly" })
    expect(await auth(secret)).toMatchObject({
      access: { role: "readonly", scope: { tubeIds: [t.id] } },
    })

    const rotated = await admin.apiKeys.rotate("k")
    expect(rotated.secret).not.toBe(secret)
    await expect(auth(secret)).rejects.toThrow(UnauthorizedError)
    expect(await auth(rotated.secret)).toMatchObject({ id: "k" })

    expect((await admin.apiKeys.revoke("k")).status).toBe("revoked")
    await expect(auth(rotated.secret)).rejects.toThrow(UnauthorizedError)

    await admin.apiKeys.delete("k")
    await expect(admin.apiKeys.get("k")).rejects.toThrow(NotFoundError)

    const log = await admin.apiKeys.auditLog({ targetId: "k" })
    expect(log.data.map((e) => e.action)).toEqual([
      "api_key.deleted",
      "api_key.revoked",
      "api_key.secret_rotated",
      "api_key.updated",
      "api_key.created",
    ])
    expect(log.data.every((e) => e.actor === "user:admin")).toBe(true)
    expect(log.data[3]).toMatchObject({
      targetType: "api_key",
      oldValue: { role: "agent", scope: null },
      newValue: { role: "readonly", scope: { tubeIds: [t.id] } },
    })
    expect(JSON.stringify(log.data)).not.toContain(rotated.secret)
    expect(JSON.stringify(log.data)).not.toContain("secretHash")
  })

  it("rolls back the key when the audit write fails", async () => {
    vi.spyOn(storage.audit, "append").mockRejectedValueOnce(new Error("disk"))
    await expect(
      admin.apiKeys.create({ id: "k", role: "readonly" })
    ).rejects.toThrow("disk")
    expect(await storage.apiKeys.list()).toEqual([])
  })
})
