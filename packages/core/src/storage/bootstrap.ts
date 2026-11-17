import { readdir } from "node:fs/promises"
import path from "node:path"

import { requireMongoUri, storageConfigFromEnv } from "./index"
import { COLLECTION_FILES } from "./json/files"
import { loadSeed, resetStorageData } from "./seed"
import { isSqliteDbEmpty } from "./sqlite/dataset"

type Env = Record<string, string | undefined>

export type SeedOnStartResult =
  | { seeded: false; reason: "disabled" | "unsupported-driver" | "not-empty" }
  | { seeded: true; dataDir: string; seedFile: string; counts: string }

const TRUE_VALUES = new Set(["1", "true", "yes", "on"])

/** `MCPOCKET_SEED_ON_FIRST_START` — default off (Docker Compose turns it on). */
export function seedOnFirstStartEnabled(env: Env = process.env): boolean {
  return TRUE_VALUES.has(
    env.MCPOCKET_SEED_ON_FIRST_START?.trim().toLowerCase() ?? ""
  )
}

/** Default seed file: `SEED_FILE` or `<cwd>/mock/seed.json`. */
export function seedFileFromEnv(env: Env = process.env): string {
  return path.resolve(
    /* turbopackIgnore: true */
    env.SEED_FILE?.trim() ||
      path.join(/* turbopackIgnore: true */ process.cwd(), "mock", "seed.json")
  )
}

/** True when the JSON data directory is missing or holds no collection file. */
export async function isJsonDataDirEmpty(dataDir: string): Promise<boolean> {
  let entries: string[]
  try {
    entries = await readdir(dataDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
  const files = new Set<string>(Object.values(COLLECTION_FILES))
  return !entries.some((entry) => files.has(entry))
}

/**
 * Seeds the storage (JSON data directory, SQLite file or MongoDB workspace) from the seed file
 * when enabled and it has never been written (a fresh Docker volume). Never touches an
 * existing dataset, so restarts and upgrades keep their data. Must run before
 * the storage singleton loads (it is called first in `instrumentation.ts`).
 */
export async function seedOnFirstStart(
  env: Env = process.env
): Promise<SeedOnStartResult> {
  if (!seedOnFirstStartEnabled(env))
    return { seeded: false, reason: "disabled" }
  const config = storageConfigFromEnv(env)
  let empty: boolean
  if (config.driver === "json") empty = await isJsonDataDirEmpty(config.dataDir)
  else if (config.driver === "sqlite")
    empty = isSqliteDbEmpty(config.sqliteFile)
  else if (config.driver === "mongo") {
    const { isMongoDbEmpty } = await import("./mongo/dataset")
    empty = await isMongoDbEmpty(
      requireMongoUri(config),
      config.mongoDb,
      config.mongoWorkspace
    )
  } else return { seeded: false, reason: "unsupported-driver" }
  if (!empty) return { seeded: false, reason: "not-empty" }
  const seedFile = seedFileFromEnv(env)
  const dataset = await loadSeed(seedFile)
  await resetStorageData(config, dataset)
  return {
    seeded: true,
    dataDir:
      config.driver === "sqlite"
        ? config.sqliteFile
        : config.driver === "mongo"
          ? `mongodb database "${config.mongoDb}", workspace "${config.mongoWorkspace}"`
          : config.dataDir,
    seedFile,
    counts:
      `${dataset.folders.length} folders, ${dataset.tubes.length} tubes, ` +
      `${dataset.items.length} items, ${dataset.history.length} history events`,
  }
}
