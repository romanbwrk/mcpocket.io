import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { StorageError } from "../errors"
import { createJsonStorage } from "./json-storage"
import { loadSeed, resetJsonDataDir } from "../seed"
import {
  makeApiKey,
  makeEvent,
  makeFolder,
  makeItem,
  runStorageContract,
} from "../testing/contract"

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mcpocket-json-"))
  tempDirs.push(dir)
  return dir
}
async function cleanupTempDirs() {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await chmod(dir, 0o700).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    })
  )
}

runStorageContract("json", {
  create: async () => createJsonStorage({ dataDir: await tempDir() }),
  cleanup: cleanupTempDirs,
})

describe("JSON adapter persistence", () => {
  let dataDir: string
  beforeEach(async () => {
    dataDir = await tempDir()
  })
  afterEach(cleanupTempDirs)

  it("starts empty when the data directory has no files", async () => {
    const storage = await createJsonStorage({
      dataDir: path.join(dataDir, "missing"),
    })
    expect(await storage.folders.list()).toEqual([])
  })

  it("persists every write so a new instance sees it", async () => {
    const storage = await createJsonStorage({ dataDir })
    const folder = await storage.folders.create(makeFolder({ name: "Sales" }))
    const item = await storage.items.create(makeItem(folder.id))
    await storage.history.append(makeEvent(item.id))
    await storage.items.update(item.id, { status: "completed" })
    await storage.close()

    const reopened = await createJsonStorage({ dataDir })
    expect(await reopened.folders.get(folder.id)).toEqual(folder)
    expect((await reopened.items.get(item.id))?.status).toBe("completed")
    expect(await reopened.history.count({ itemId: item.id })).toBe(1)
  })

  it("writes only the touched collections and leaves no *.tmp files", async () => {
    const storage = await createJsonStorage({ dataDir })
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        storage.folders.create(makeFolder({ name: `f${i}` }))
      )
    )
    const files = await readdir(dataDir)
    expect(files).toEqual(["folders.json"])
    const onDisk = JSON.parse(
      await readFile(path.join(dataDir, "folders.json"), "utf8")
    )
    expect(onDisk).toHaveLength(20)
  })

  it("keeps memory unchanged when persisting fails", async () => {
    const storage = await createJsonStorage({ dataDir })
    const kept = await storage.folders.create(makeFolder())
    await chmod(dataDir, 0o500) // read-only: tmp file cannot be created
    await expect(storage.folders.create(makeFolder())).rejects.toThrow()
    await chmod(dataDir, 0o700)
    expect(await storage.folders.list()).toEqual([kept])
    // The queue is not stuck after a failure.
    await storage.folders.create(makeFolder())
    expect(await storage.folders.count()).toBe(2)
  })

  it("refuses to load invalid data files", async () => {
    await writeFile(
      path.join(dataDir, "items.json"),
      JSON.stringify([{ id: "nope" }])
    )
    await expect(createJsonStorage({ dataDir })).rejects.toBeInstanceOf(
      StorageError
    )
    await writeFile(path.join(dataDir, "items.json"), "{not json")
    await expect(createJsonStorage({ dataDir })).rejects.toBeInstanceOf(
      StorageError
    )
  })
})

describe("seed", () => {
  afterEach(cleanupTempDirs)

  it("keeps API keys and the access audit log when re-seeding", async () => {
    const dataDir = await tempDir()
    const before = await createJsonStorage({ dataDir })
    await before.apiKeys.create(makeApiKey({ id: "keep-me" }))
    await before.close()
    const seed = await loadSeed(path.join(process.cwd(), "mock", "seed.json"))
    await resetJsonDataDir(dataDir, seed)
    const after = await createJsonStorage({ dataDir })
    expect((await after.apiKeys.list()).map((k) => k.id)).toEqual(["keep-me"])
    expect(await after.folders.count()).toBeGreaterThan(0)
  })

  it("loads mock/seed.json into a data directory the adapter can read", async () => {
    const dataDir = await tempDir()
    const seed = await loadSeed(path.join(process.cwd(), "mock", "seed.json"))
    await writeFile(path.join(dataDir, "stale.json.123.tmp"), "x")
    await resetJsonDataDir(dataDir, seed)

    expect((await readdir(dataDir)).sort()).toEqual([
      "folders.json",
      "history.json",
      "items.json",
      "tubes.json",
      "webhook-deliveries.json", // outbox reset (refers to old items)
    ])
    const storage = await createJsonStorage({ dataDir })
    const roots = await storage.folders.list({ parentId: null })
    expect(roots.map((f) => f.name)).toEqual(["Demo"])
    const tubes = await storage.tubes.list()
    expect(tubes.map((t) => t.name)).toEqual(["Tasks"])
    expect(await storage.items.count({ includeDeleted: true })).toBe(
      seed.items.length
    )
  })

  it("rejects seeds with dangling references", async () => {
    const dir = await tempDir()
    const file = path.join(dir, "seed.json")
    await writeFile(
      file,
      JSON.stringify({
        folders: [makeFolder({ parentId: crypto.randomUUID() })],
        tubes: [],
        items: [],
      })
    )
    await expect(loadSeed(file)).rejects.toThrow(/unknown parentId/)
  })
})

describe("getStorage singleton", () => {
  afterEach(async () => {
    const { resetStorageSingleton } = await import("..")
    await resetStorageSingleton()
    vi.unstubAllEnvs()
    await cleanupTempDirs()
  })

  it("returns one instance per process, even after modules are re-evaluated (hot reload)", async () => {
    vi.stubEnv("STORAGE_DRIVER", "json")
    vi.stubEnv("DATA_DIR", await tempDir())
    const first = await import("..")
    const [a, b] = await Promise.all([first.getStorage(), first.getStorage()])
    expect(a).toBe(b)

    vi.resetModules()
    const reloaded = await import("..")
    expect(reloaded).not.toBe(first)
    expect(await reloaded.getStorage()).toBe(a)
  })

  it("rejects unknown drivers", async () => {
    const { storageConfigFromEnv } = await import("..")
    expect(() => storageConfigFromEnv({ STORAGE_DRIVER: "postgres" })).toThrow(
      /Unknown STORAGE_DRIVER/
    )
    expect(storageConfigFromEnv({}).driver).toBe("json")
  })
})
