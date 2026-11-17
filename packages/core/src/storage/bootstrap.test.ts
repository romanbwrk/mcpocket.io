import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readDataset } from "./json/files"

import { isJsonDataDirEmpty, seedOnFirstStart } from "./bootstrap"

const SEED_FILE = fileURLToPath(
  new URL("../../../../mock/seed.json", import.meta.url)
)
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mcpocket-bootstrap-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const env = (dataDir: string, enabled = "true") => ({
  STORAGE_DRIVER: "json",
  DATA_DIR: dataDir,
  SEED_FILE,
  MCPOCKET_SEED_ON_FIRST_START: enabled,
})

describe("seedOnFirstStart", () => {
  it("is off by default", async () => {
    const dataDir = path.join(root, "data")
    expect(await seedOnFirstStart({ DATA_DIR: dataDir })).toEqual({
      seeded: false,
      reason: "disabled",
    })
    expect(await isJsonDataDirEmpty(dataDir)).toBe(true)
  })

  it("seeds a missing / empty data directory", async () => {
    const dataDir = path.join(root, "data")
    const result = await seedOnFirstStart(env(dataDir))
    expect(result.seeded).toBe(true)
    const dataset = await readDataset(dataDir)
    expect(dataset.folders.length).toBeGreaterThan(0)
    expect(dataset.items.length).toBeGreaterThan(0)
  })

  it("seeds a directory that only holds unrelated files (e.g. lost+found)", async () => {
    await writeFile(path.join(root, ".keep"), "")
    expect((await seedOnFirstStart(env(root))).seeded).toBe(true)
  })

  it("never touches an existing dataset", async () => {
    await writeFile(path.join(root, "folders.json"), "[]\n")
    expect(await seedOnFirstStart(env(root))).toEqual({
      seeded: false,
      reason: "not-empty",
    })
    expect(await readdir(root)).toEqual(["folders.json"])
  })
})
