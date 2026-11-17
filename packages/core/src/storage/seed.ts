import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import { DatasetSchema, type Dataset } from "../domain/schemas"
import { StorageError } from "./errors"
import {
  COLLECTION_FILES,
  writeDataset,
  type CollectionName,
} from "./json/files"
import { requireMongoUri, type StorageConfig } from "./index"
import { replaceSqliteDataset } from "./sqlite/dataset"

/**
 * Access/config collections (API keys, audit log, webhook subscriptions)
 * survive a re-seed unless the seed file itself provides entries for them:
 * seeding resets demo data, not who may access the server or who gets
 * notified. The webhook outbox is reset (it refers to the old items).
 */
const ACCESS_COLLECTIONS: CollectionName[] = ["apiKeys", "audit", "webhooks"]

/** Reads and validates a seed file (also checks that references resolve). */
export async function loadSeed(seedFile: string): Promise<Dataset> {
  const parsed = DatasetSchema.safeParse(
    JSON.parse(await readFile(seedFile, "utf8"))
  )
  if (!parsed.success) {
    throw new StorageError(
      `${seedFile}: invalid seed\n${z.prettifyError(parsed.error)}`
    )
  }
  assertReferentialIntegrity(parsed.data)
  return parsed.data
}

function assertReferentialIntegrity({
  folders,
  tubes,
  items,
  history,
}: Dataset): void {
  const problems: string[] = []
  const unique = (kind: string, ids: string[]) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) problems.push(`duplicate ${kind} id ${id}`)
      seen.add(id)
    }
    return seen
  }
  const folderIds = unique(
    "folder",
    folders.map((f) => f.id)
  )
  const tubeIds = unique(
    "tube",
    tubes.map((t) => t.id)
  )
  const itemIds = unique(
    "item",
    items.map((i) => i.id)
  )
  unique(
    "history",
    history.map((h) => h.id)
  )

  for (const f of folders) {
    if (f.parentId !== null && !folderIds.has(f.parentId)) {
      problems.push(`folder ${f.id}: unknown parentId ${f.parentId}`)
    }
  }
  for (const t of tubes) {
    if (t.folderId !== null && !folderIds.has(t.folderId))
      problems.push(`tube ${t.id}: unknown folderId ${t.folderId}`)
  }
  for (const i of items) {
    if (!tubeIds.has(i.tubeId))
      problems.push(`item ${i.id}: unknown tubeId ${i.tubeId}`)
  }
  for (const h of history) {
    if (!itemIds.has(h.itemId))
      problems.push(`history ${h.id}: unknown itemId ${h.itemId}`)
  }
  if (problems.length > 0)
    throw new StorageError(`Seed integrity errors:\n${problems.join("\n")}`)
}

/** Collections a seed replaces: all except access collections it leaves empty. */
function seededCollections(dataset: Dataset): CollectionName[] {
  return (Object.keys(COLLECTION_FILES) as CollectionName[]).filter(
    (name) => !ACCESS_COLLECTIONS.includes(name) || dataset[name].length > 0
  )
}

/** SQLite counterpart of `resetJsonDataDir` (same access-collection rule). */
export async function resetSqliteDb(
  file: string,
  dataset: Dataset
): Promise<void> {
  replaceSqliteDataset(file, dataset, seededCollections(dataset))
}

/**
 * MongoDB counterpart of `resetJsonDataDir` (same access-collection rule).
 * Only `workspace`'s documents are replaced; other workspaces are untouched.
 */
export async function resetMongoDb(
  uri: string,
  dbName: string,
  workspace: string,
  dataset: Dataset
): Promise<void> {
  const { replaceMongoDataset } = await import("./mongo/dataset")
  await replaceMongoDataset(
    uri,
    dbName,
    workspace,
    dataset,
    seededCollections(dataset)
  )
}

/** Resets the storage selected by `config` to `dataset`. */
export async function resetStorageData(
  config: Pick<StorageConfig, "driver" | "dataDir" | "sqliteFile"> &
    Partial<Pick<StorageConfig, "mongoUri" | "mongoDb" | "mongoWorkspace">>,
  dataset: Dataset
): Promise<void> {
  if (config.driver === "json") return resetJsonDataDir(config.dataDir, dataset)
  if (config.driver === "sqlite")
    return resetSqliteDb(config.sqliteFile, dataset)
  if (config.driver === "mongo")
    return resetMongoDb(
      requireMongoUri(config),
      config.mongoDb ?? "mcpocket",
      config.mongoWorkspace ?? "default",
      dataset
    )
  throw new StorageError(
    `Seeding is not supported for STORAGE_DRIVER "${config.driver}"`
  )
}

/**
 * Resets a JSON data directory to `dataset`: removes the collection files and
 * leftover `*.tmp` files, then writes every collection atomically. API keys
 * the access audit log and webhook subscriptions are kept when the seed has none (see above).
 */
export async function resetJsonDataDir(
  dataDir: string,
  dataset: Dataset
): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const names = seededCollections(dataset)
  const replaced = new Set<string>(names.map((name) => COLLECTION_FILES[name]))
  for (const entry of await readdir(dataDir)) {
    if (replaced.has(entry) || entry.endsWith(".tmp")) {
      await rm(path.join(dataDir, entry), { force: true })
    }
  }
  await writeDataset(dataDir, dataset, names)
}
