import { randomBytes, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { seedOnFirstStart } from "../bootstrap"
import { storageConfigFromEnv, createStorage } from "../index"
import { loadSeed, resetMongoDb } from "../seed"
import {
  makeApiKey,
  makeFolder,
  makeItem,
  makeTube,
  runStorageContract,
} from "../testing/contract"
import type { Storage } from "../types"

import { isMongoDbEmpty, replaceMongoDataset } from "./dataset"
import { connectMongo, createMongoStorage } from "./mongo-storage"

/**
 * Runs against a real MongoDB when `MONGODB_TEST_URI` is set, e.g.
 *   MONGODB_TEST_URI=mongodb://localhost:27017 npm test
 * Every test gets its own `mcpocket_test_<random>` database, dropped afterwards.
 */
const URI = process.env.MONGODB_TEST_URI?.trim()

const SEED_FILE = fileURLToPath(
  new URL("../../../../../mock/seed.json", import.meta.url)
)

const databases: string[] = []
const open: Storage[] = []

function tempDbName(): string {
  const name = `mcpocket_test_${randomBytes(6).toString("hex")}`
  databases.push(name)
  return name
}

const WS = "default"

async function openStorage(dbName: string, workspace = WS): Promise<Storage> {
  const storage = await createMongoStorage({ uri: URI!, dbName, workspace })
  open.push(storage)
  return storage
}

async function cleanup() {
  await Promise.all(open.splice(0).map((s) => s.close()))
  const names = databases.splice(0)
  if (!names.length) return
  const client = await connectMongo(URI!)
  try {
    await Promise.all(names.map((name) => client.db(name).dropDatabase()))
  } finally {
    await client.close()
  }
}

describe("MongoDB config", () => {
  it("reads MONGODB_URI / MONGODB_DB with a default database", () => {
    expect(
      storageConfigFromEnv({
        STORAGE_DRIVER: "mongo",
        MONGODB_URI: "mongodb://h",
      })
    ).toMatchObject({
      driver: "mongo",
      mongoUri: "mongodb://h",
      mongoDb: "mcpocket",
      mongoWorkspace: "default",
    })
    expect(
      storageConfigFromEnv({ STORAGE_DRIVER: "mongo", MONGODB_DB: "x" }).mongoDb
    ).toBe("x")
  })

  it("takes the workspace from MCPOCKET_WORKSPACE, else MCPOCKET_SSO_WORKSPACE", () => {
    const mongo = { STORAGE_DRIVER: "mongo" }
    expect(
      storageConfigFromEnv({ ...mongo, MCPOCKET_SSO_WORKSPACE: " acme " })
        .mongoWorkspace
    ).toBe("acme")
    expect(
      storageConfigFromEnv({
        ...mongo,
        MCPOCKET_WORKSPACE: "beta",
        MCPOCKET_SSO_WORKSPACE: "acme",
      }).mongoWorkspace
    ).toBe("beta")
  })

  it("rejects an invalid workspace slug", async () => {
    await expect(
      createMongoStorage({
        uri: "mongodb://h",
        dbName: "x",
        workspace: "a:b",
      })
    ).rejects.toThrow(/workspace/)
  })

  it("refuses to start without MONGODB_URI", async () => {
    await expect(
      createStorage(storageConfigFromEnv({ STORAGE_DRIVER: "mongo" }))
    ).rejects.toThrow(/MONGODB_URI/)
  })
})

if (URI) {
  runStorageContract("mongo", {
    create: () => openStorage(tempDbName()),
    cleanup,
  })
}

describe.skipIf(!URI)("MongoDB adapter", { timeout: 30_000 }, () => {
  afterEach(cleanup)

  it("persists writes so a new instance sees them", async () => {
    const dbName = tempDbName()
    const a = await openStorage(dbName)
    const folder = await a.folders.create(makeFolder({ name: "Persisted" }))
    const tube = await a.tubes.create(makeTube(folder.id))
    await a.items.create(makeItem(tube.id, { idempotencyKey: "k1" }))
    await a.close()

    const b = await openStorage(dbName)
    expect(await b.folders.get(folder.id)).toEqual(folder)
    expect(await b.items.count({ tubeId: tube.id })).toBe(1)
    expect(await b.items.findByIdempotencyKey(tube.id, "k1")).not.toBeNull()
  })

  it("orders timestamps with different UTC offsets by instant", async () => {
    const s = await openStorage(tempDbName())
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

  it("keeps payload keys Mongo treats specially", async () => {
    const s = await openStorage(tempDbName())
    const item = await s.items.create(
      makeItem(randomUUID(), {
        payload: { "a.b": 1, nested: { $weird: [1, "x"] } },
      })
    )
    expect(await s.items.get(item.id)).toEqual(item)
  })

  it("rejects writes after close", async () => {
    const s = await createMongoStorage({
      uri: URI!,
      dbName: tempDbName(),
      workspace: WS,
    })
    await s.close()
    await expect(s.folders.create(makeFolder())).rejects.toThrow(/closed/)
  })

  it("reports emptiness and replaces collections under a running server", async () => {
    const dbName = tempDbName()
    expect(await isMongoDbEmpty(URI!, dbName, WS)).toBe(true)
    const s = await openStorage(dbName)
    await s.apiKeys.create(makeApiKey())
    const folder = await s.folders.create(makeFolder())
    expect(await isMongoDbEmpty(URI!, dbName, WS)).toBe(false)

    const dataset = await loadSeed(SEED_FILE)
    await resetMongoDb(URI!, dbName, WS, dataset)
    // Seed has no API keys: managed keys survive a re-seed (like JSON).
    expect(await s.apiKeys.count()).toBe(1)
    expect(await s.folders.get(folder.id)).toBeNull()
    expect(await s.items.count({ includeDeleted: true })).toBe(
      dataset.items.length
    )
    // New writes after a re-seed still get fresh insertion positions.
    const extra = await s.folders.create(
      makeFolder({ createdAt: "2000-01-01T00:00:00.000Z" })
    )
    expect((await s.folders.list())[0].id).toBe(extra.id)

    await replaceMongoDataset(URI!, dbName, WS, { ...dataset, apiKeys: [] })
    expect(await s.apiKeys.count()).toBe(0)
  })

  it("keeps workspaces sharing one database apart", async () => {
    const dbName = tempDbName()
    const acme = await openStorage(dbName, "acme")
    const beta = await openStorage(dbName, "beta")

    // The same entity id may exist in both workspaces.
    const folder = makeFolder({ name: "Acme" })
    await acme.folders.create(folder)
    await beta.folders.create({ ...folder, name: "Beta" })
    expect((await acme.folders.get(folder.id))?.name).toBe("Acme")
    expect((await beta.folders.get(folder.id))?.name).toBe("Beta")

    const tube = await acme.tubes.create(makeTube(folder.id))
    await acme.items.create(makeItem(tube.id, { idempotencyKey: "k" }))
    expect(await acme.items.count()).toBe(1)
    expect(await beta.items.count()).toBe(0)
    expect(await beta.tubes.get(tube.id)).toBeNull()
    expect(await beta.items.findByIdempotencyKey(tube.id, "k")).toBeNull()

    // Writes and deletes stay inside the workspace.
    await beta.folders.update(folder.id, { name: "Beta 2" })
    expect((await acme.folders.get(folder.id))?.name).toBe("Acme")
    expect(await beta.folders.delete(folder.id)).toBe(true)
    expect(await acme.folders.get(folder.id)).not.toBeNull()
    expect(await beta.tubes.delete(tube.id)).toBe(false)

    // Seeding one workspace leaves the other alone.
    const dataset = await loadSeed(SEED_FILE)
    expect(await isMongoDbEmpty(URI!, dbName, "gamma")).toBe(true)
    await resetMongoDb(URI!, dbName, "beta", dataset)
    expect(await beta.folders.count()).toBe(dataset.folders.length)
    expect(await acme.folders.count()).toBe(1)
    expect(await acme.items.count()).toBe(1)
    await resetMongoDb(URI!, dbName, "acme", dataset)
    expect(await acme.folders.count()).toBe(dataset.folders.length)
    expect(await beta.folders.count()).toBe(dataset.folders.length)
  })

  it("seeds an empty database once", async () => {
    const dbName = tempDbName()
    const env = {
      STORAGE_DRIVER: "mongo",
      MONGODB_URI: URI,
      MONGODB_DB: dbName,
      SEED_FILE,
      MCPOCKET_SEED_ON_FIRST_START: "true",
    }
    expect((await seedOnFirstStart(env)).seeded).toBe(true)
    expect(await seedOnFirstStart(env)).toEqual({
      seeded: false,
      reason: "not-empty",
    })
    const s = await openStorage(dbName)
    expect(await s.folders.count()).toBeGreaterThan(0)
  })
})
