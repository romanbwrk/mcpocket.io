import type { Dataset } from "../../domain/schemas"

import {
  allocateSeq,
  assertWorkspace,
  COLLECTIONS,
  connectMongo,
  ensureIndexes,
  resetSeq,
  supportsTransactions,
  toDoc,
  WORKSPACE_FIELD,
  type CollectionKey,
} from "./mongo-storage"

/** True when no collection of the database has a document of `workspace`. */
export async function isMongoDbEmpty(
  uri: string,
  dbName: string,
  workspace: string
): Promise<boolean> {
  assertWorkspace(workspace)
  const client = await connectMongo(uri)
  try {
    const db = client.db(dbName)
    for (const { collection } of Object.values(COLLECTIONS)) {
      if (
        await db
          .collection(collection)
          .findOne({ [WORKSPACE_FIELD]: workspace }, { projection: { _id: 1 } })
      )
        return false
    }
    return true
  } finally {
    await client.close()
  }
}

/**
 * Replaces the given collections (default: all) of `workspace` with
 * `dataset`; other workspaces in the database are not touched. Safe while a
 * server is running: the MongoDB adapter keeps no cache, so it reads the new
 * documents immediately. Runs in one MongoDB transaction on replica sets; on
 * a standalone server collections are replaced one after another.
 */
export async function replaceMongoDataset(
  uri: string,
  dbName: string,
  workspace: string,
  dataset: Dataset,
  names: CollectionKey[] = Object.keys(COLLECTIONS) as CollectionKey[]
): Promise<void> {
  assertWorkspace(workspace)
  const client = await connectMongo(uri)
  try {
    const db = client.db(dbName)
    await ensureIndexes(db)
    const replace = async (session?: import("mongodb").ClientSession) => {
      for (const name of names) {
        const { collection } = COLLECTIONS[name]
        const entities = dataset[name]
        await db
          .collection(collection)
          .deleteMany({ [WORKSPACE_FIELD]: workspace }, { session })
        await resetSeq(db, workspace, collection, session)
        if (entities.length === 0) continue
        const first = await allocateSeq(
          db,
          workspace,
          collection,
          entities.length,
          session
        )
        await db.collection(collection).insertMany(
          entities.map((entity, i) => toDoc(entity, first + i, workspace)),
          { session }
        )
      }
    }
    if (!(await supportsTransactions(db))) return await replace()
    const session = client.startSession()
    try {
      await session.withTransaction(() => replace(session))
    } finally {
      await session.endSession()
    }
  } finally {
    await client.close()
  }
}
