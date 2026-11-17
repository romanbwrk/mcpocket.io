import path from "node:path"

import { multiWorkspaceEnabled, workspaceFromEnv } from "../workspace"
import { StorageError } from "./errors"
import { createJsonStorage } from "./json/json-storage"
import { createSqliteStorage } from "./sqlite/sqlite-storage"
import type { Storage, StorageDriver } from "./types"

export * from "./errors"
export type * from "./types"

export type StorageConfig = {
  driver: StorageDriver
  /** JSON driver: directory with the collection files. */
  dataDir: string
  /** SQLite driver: database file. */
  sqliteFile: string
  /** MongoDB driver: connection string (required for `mongo`). */
  mongoUri?: string
  /** MongoDB driver: database name. */
  mongoDb: string
  /** MongoDB driver: tenant this instance reads and writes (`workspace` field). */
  mongoWorkspace: string
}

/**
 * Reads storage config from the environment:
 * - `STORAGE_DRIVER`: `json` (default) | `sqlite` | `mongo`
 * - `DATA_DIR`: data directory, default `<cwd>/data`
 * - `SQLITE_FILE`: SQLite database file, default `<DATA_DIR>/mcpocket.db`
 * - `MONGODB_URI`: MongoDB connection string (required for `mongo`)
 * - `MONGODB_DB`: MongoDB database name, default `mcpocket`
 * - `MCPOCKET_WORKSPACE` (else `MCPOCKET_SSO_WORKSPACE`, else `default`):
 *   tenant inside that database — all documents carry a `workspace` field,
 *   so one database serves many workspaces (see `../workspace.ts`).
 */
export function storageConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): StorageConfig {
  const driver = (env.STORAGE_DRIVER?.trim() || "json") as StorageDriver
  if (driver !== "json" && driver !== "sqlite" && driver !== "mongo") {
    throw new StorageError(
      `Unknown STORAGE_DRIVER "${driver}" (expected "json", "sqlite" or "mongo")`
    )
  }
  // Runtime paths (Docker volume): not build inputs — see json/files.ts.
  const dataDir = path.resolve(
    /* turbopackIgnore: true */
    env.DATA_DIR?.trim() ||
      path.join(/* turbopackIgnore: true */ process.cwd(), "data")
  )
  const sqliteFile = path.resolve(
    /* turbopackIgnore: true */
    dataDir,
    env.SQLITE_FILE?.trim() || "mcpocket.db"
  )
  return {
    driver,
    dataDir,
    sqliteFile,
    mongoUri: env.MONGODB_URI?.trim() || undefined,
    mongoDb: env.MONGODB_DB?.trim() || "mcpocket",
    mongoWorkspace:
      driver === "mongo" ? (workspaceFromEnv(env) ?? "default") : "default",
  }
}

/** Builds a fresh storage instance. Prefer `getStorage()` in application code. */
export async function createStorage(config: StorageConfig): Promise<Storage> {
  if (multiWorkspaceEnabled() && config.driver !== "mongo") {
    throw new StorageError(
      'MCPOCKET_MULTI_WORKSPACE needs STORAGE_DRIVER "mongo"'
    )
  }
  switch (config.driver) {
    case "json":
      return createJsonStorage({ dataDir: config.dataDir })
    case "sqlite":
      return createSqliteStorage({ file: config.sqliteFile })
    case "mongo": {
      // Loaded lazily so the other drivers never load the MongoDB client.
      const { createMongoStorage } = await import("./mongo/mongo-storage")
      return createMongoStorage({
        uri: requireMongoUri(config),
        dbName: config.mongoDb,
        workspace: config.mongoWorkspace,
      })
    }
  }
}

/** The MongoDB connection string, or a clear error when it is missing. */
export function requireMongoUri(config: Pick<StorageConfig, "mongoUri">) {
  if (!config.mongoUri) {
    throw new StorageError('STORAGE_DRIVER "mongo" needs MONGODB_URI')
  }
  return config.mongoUri
}

const globalKey = Symbol.for("mcpocket.storage")
type GlobalWithStorage = typeof globalThis & { [globalKey]?: Promise<Storage> }

/**
 * Process-wide storage singleton. Cached on `globalThis` so Next.js dev hot
 * reloads (which re-evaluate modules) reuse the already-loaded instance
 * instead of loading the data files again and racing the old instance's
 * write queue.
 *
 * `workspace` (multi-workspace mode, see `../workspace.ts`): the same
 * storage scoped to that workspace. An empty workspace is seeded on first
 * use when `MCPOCKET_SEED_ON_FIRST_START` is on. Ignored by single-workspace
 * drivers (JSON, SQLite).
 */
export async function getStorage(workspace?: string): Promise<Storage> {
  const g = globalThis as GlobalWithStorage
  if (!g[globalKey]) {
    const pending = createStorage(storageConfigFromEnv())
    g[globalKey] = pending
    // Allow a retry after a failed initialisation (e.g. a corrupt data file).
    pending.catch(() => {
      if (g[globalKey] === pending) delete g[globalKey]
    })
  }
  const storage = await g[globalKey]
  if (!workspace || !storage.forWorkspace || workspace === storage.workspace)
    return storage
  await seedWorkspaceOnce(workspace)
  return storage.forWorkspace(workspace)
}

const seededKey = Symbol.for("mcpocket.seededWorkspaces")
type GlobalWithSeeded = typeof globalThis & {
  [seededKey]?: Map<string, Promise<void>>
}

/** First use of a workspace in this process: seed it if empty (and enabled). */
function seedWorkspaceOnce(workspace: string): Promise<void> {
  const g = globalThis as GlobalWithSeeded
  const seen = (g[seededKey] ??= new Map())
  let pending = seen.get(workspace)
  if (!pending) {
    pending = import("./bootstrap")
      .then(({ seedOnFirstStart }) =>
        seedOnFirstStart({ ...process.env, MCPOCKET_WORKSPACE: workspace })
      )
      .then((result) => {
        if (result.seeded) {
          console.info(
            `[mcpocket] empty workspace "${workspace}" seeded from ${result.seedFile}: ${result.counts}`
          )
        }
      })
    seen.set(workspace, pending)
    // Retry on the next request after a failure.
    pending.catch(() => seen.delete(workspace))
  }
  return pending
}

/** Test helper: drops the cached singleton (after closing it). */
export async function resetStorageSingleton(): Promise<void> {
  const g = globalThis as GlobalWithStorage
  const pending = g[globalKey]
  delete g[globalKey]
  delete (globalThis as GlobalWithSeeded)[seededKey]
  if (pending) await (await pending.catch(() => null))?.close()
}
