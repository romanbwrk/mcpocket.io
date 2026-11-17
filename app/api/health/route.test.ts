import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetStorageSingleton } from "@mcpocket/core/storage"

import { GET, HEAD } from "./route"

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-health-"))
  vi.stubEnv("DATA_DIR", dataDir)
  vi.stubEnv("STORAGE_DRIVER", "json")
  vi.stubEnv("MCPOCKET_API_KEYS", "")
  await resetStorageSingleton()
})
afterEach(async () => {
  await resetStorageSingleton()
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

describe("GET /api/health", () => {
  it("is public and reports ok without leaking data", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({
      status: "ok",
      checks: { storage: "ok" },
    })
    expect((await HEAD()).status).toBe(200)
  })

  it("returns 503 without details when storage cannot load", async () => {
    await writeFile(path.join(dataDir, "folders.json"), "{not json")
    const res = await GET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({ status: "error", checks: { storage: "error" } })
    expect(JSON.stringify(body)).not.toContain(dataDir)
  })
})
