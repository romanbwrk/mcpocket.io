import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import {
  ApiKeyRecordSchema,
  AuditEventSchema,
  FolderSchema,
  HistoryEventSchema,
  ItemSchema,
  TubeSchema,
  WebhookDeliverySchema,
  WebhookSchema,
  type Dataset,
} from "../../domain/schemas"
import { StorageError } from "../errors"

/** One JSON file per collection inside the data directory (plan §7.2). */
export const COLLECTION_FILES = {
  folders: "folders.json",
  tubes: "tubes.json",
  items: "items.json",
  history: "history.json",
  apiKeys: "api-keys.json",
  audit: "audit.json",
  webhooks: "webhooks.json",
  webhookDeliveries: "webhook-deliveries.json",
} as const satisfies Record<keyof Dataset, string>

export type CollectionName = keyof typeof COLLECTION_FILES

const collectionSchemas = {
  folders: z.array(FolderSchema),
  tubes: z.array(TubeSchema),
  items: z.array(ItemSchema),
  history: z.array(HistoryEventSchema),
  apiKeys: z.array(ApiKeyRecordSchema),
  audit: z.array(AuditEventSchema),
  webhooks: z.array(WebhookSchema),
  webhookDeliveries: z.array(WebhookDeliverySchema),
} as const

/**
 * Atomically replaces `file` with `contents`: write + fsync a sibling
 * `*.tmp` file, then `rename` over the target (atomic on POSIX filesystems).
 */
export async function writeFileAtomic(
  file: string,
  contents: string
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmp, "w")
    try {
      await handle.writeFile(contents, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

export async function writeCollection<K extends CollectionName>(
  dataDir: string,
  name: K,
  entities: Dataset[K]
): Promise<void> {
  await writeFileAtomic(
    path.join(/* turbopackIgnore: true */ dataDir, COLLECTION_FILES[name]),
    `${JSON.stringify(entities, null, 2)}\n`
  )
}

/** Reads and validates one collection file; a missing file is an empty collection. */
export async function readCollection<K extends CollectionName>(
  dataDir: string,
  name: K
): Promise<Dataset[K]> {
  // Runtime data lives outside the build output (DATA_DIR / Docker volume):
  // keep the file tracer from bundling the whole project.
  const file = path.join(
    /* turbopackIgnore: true */ dataDir,
    COLLECTION_FILES[name]
  )
  let raw: string
  try {
    raw = await readFile(/* turbopackIgnore: true */ file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new StorageError(`${file}: invalid JSON`, { cause: error })
  }
  const parsed = collectionSchemas[name].safeParse(json)
  if (!parsed.success) {
    throw new StorageError(
      `${file}: invalid data\n${z.prettifyError(parsed.error)}`,
      {
        cause: parsed.error,
      }
    )
  }
  return parsed.data as Dataset[K]
}

export async function readDataset(dataDir: string): Promise<Dataset> {
  const [
    folders,
    tubes,
    items,
    history,
    apiKeys,
    audit,
    webhooks,
    webhookDeliveries,
  ] = await Promise.all([
    readCollection(dataDir, "folders"),
    readCollection(dataDir, "tubes"),
    readCollection(dataDir, "items"),
    readCollection(dataDir, "history"),
    readCollection(dataDir, "apiKeys"),
    readCollection(dataDir, "audit"),
    readCollection(dataDir, "webhooks"),
    readCollection(dataDir, "webhookDeliveries"),
  ])
  return {
    folders,
    tubes,
    items,
    history,
    apiKeys,
    audit,
    webhooks,
    webhookDeliveries,
  }
}

/** Overwrites the given collection files in `dataDir` (default: all) with `dataset`. */
export async function writeDataset(
  dataDir: string,
  dataset: Dataset,
  names: CollectionName[] = Object.keys(COLLECTION_FILES) as CollectionName[]
): Promise<void> {
  await Promise.all(
    names.map((name) => writeCollection(dataDir, name, dataset[name]))
  )
}
