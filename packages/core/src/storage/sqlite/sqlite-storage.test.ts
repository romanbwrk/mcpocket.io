import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { storageConfigFromEnv } from "../index"
import { seedOnFirstStart } from "../bootstrap"
import { loadSeed, resetSqliteDb } from "../seed"
import {
  makeApiKey,
  makeEvent,
  makeFolder,
  makeItem,
  makeTube,
  runStorageContract,
} from "../testing/contract"
import type { Storage } from "../types"

import { isSqliteDbEmpty, replaceSqliteDataset } from "./dataset"
import { createSqliteStorage } from "./sqlite-storage"

const SEED_FILE = fileURLToPath(
  new URL("../../../../../mock/seed.json", import.meta.url)
)

const tempDirs: string[] = []
const open: Storage[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mcpocket-sqlite-"))
  tempDirs.push(dir)
  return dir
}
async function cleanup() {
  await Promise.all(open.splice(0).map((s) => s.close()))
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
}
async function openStorage(file: string): Promise<Storage> {
  const storage = await createSqliteStorage({ file })
  open.push(storage)
  return storage
}

runStorageContract("sqlite", {
  create: async () => openStorage(path.join(await tempDir(), "test.db")),
  cleanup,
})

describe("SQLite adapter", () => {
  let file: string
  beforeEach(async () => {
    file = path.join(await tempDir(), "nested", "mcpocket.db")
  })
  afterEach(cleanup)

  it("persists writes so a new instance sees them", async () => {
    const a = await openStorage(file)
    const folder = await a.folders.create(makeFolder({ name: "Persisted" }))
    const tube = await a.tubes.create(makeTube(folder.id))
    await a.items.create(makeItem(tube.id, { idempotencyKey: "k1" }))
    await a.close()

    const b = await openStorage(file)
    expect(await b.folders.get(folder.id)).toEqual(folder)
    expect(await b.items.count({ tubeId: tube.id })).toBe(1)
    expect(await b.items.findByIdempotencyKey(tube.id, "k1")).not.toBeNull()
  })

  it("orders timestamps with different UTC offsets by instant", async () => {
    const s = await openStorage(file)
    // 00:30+02:00 is 22:30Z the day before: earlier than 23:00Z.
    const late = await s.folders.create(
      makeFolder({ createdAt: "2026-11-01T23:00:00.000Z" })
    )
    const early = await s.folders.create(
      makeFolder({ createdAt: "2026-11-02T00:30:00.000+02:00" })
    )
    expect((await s.folders.list()).map((f) => f.id)).toEqual([
      early.id,
      late.id,
    ])
  })

  it("sees writes made by another process (connection) to the same file", async () => {
    const s = await openStorage(file)
    const dataset = await loadSeed(SEED_FILE)
    await resetSqliteDb(file, dataset)
    expect(await s.folders.count()).toBe(dataset.folders.length)
  })

  it("rejects writes after close", async () => {
    const s = await createSqliteStorage({ file })
    await s.close()
    await expect(s.folders.create(makeFolder())).rejects.toThrow(/closed/)
  })

  it("reports emptiness and replaces collections", async () => {
    expect(isSqliteDbEmpty(file)).toBe(true)
    const s = await openStorage(file)
    await s.apiKeys.create(makeApiKey())
    const folder = await s.folders.create(makeFolder())
    await s.history.append(makeEvent(folder.id))
    expect(isSqliteDbEmpty(file)).toBe(false)

    const dataset = await loadSeed(SEED_FILE)
    await resetSqliteDb(file, dataset)
    // Seed has no API keys: managed keys survive a re-seed (like JSON).
    expect(await s.apiKeys.count()).toBe(1)
    expect(await s.folders.get(folder.id)).toBeNull()
    expect(await s.items.count({ includeDeleted: true })).toBe(
      dataset.items.length
    )

    replaceSqliteDataset(file, { ...dataset, apiKeys: [] })
    expect(await s.apiKeys.count()).toBe(0)
  })
})

describe("SQLite config and first-start seeding", () => {
  afterEach(cleanup)

  it("defaults the database file into DATA_DIR", () => {
    const config = storageConfigFromEnv({
      STORAGE_DRIVER: "sqlite",
      DATA_DIR: "/srv/data",
    })
    expect(config.sqliteFile).toBe(path.resolve("/srv/data/mcpocket.db"))
    expect(
      storageConfigFromEnv({ DATA_DIR: "/srv/data", SQLITE_FILE: "/x/y.db" })
        .sqliteFile
    ).toBe(path.resolve("/x/y.db"))
  })

  it("seeds an empty database once", async () => {
    const dir = await tempDir()
    const env = {
      STORAGE_DRIVER: "sqlite",
      DATA_DIR: dir,
      SEED_FILE,
      MCPOCKET_SEED_ON_FIRST_START: "true",
    }
    expect((await seedOnFirstStart(env)).seeded).toBe(true)
    expect(await seedOnFirstStart(env)).toEqual({
      seeded: false,
      reason: "not-empty",
    })
    const s = await openStorage(path.join(dir, "mcpocket.db"))
    expect(await s.folders.count()).toBeGreaterThan(0)
  })
})
