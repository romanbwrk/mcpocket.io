import { AsyncLocalStorage } from "node:async_hooks"

import {
  MongoClient,
  MongoServerError,
  type AnyBulkWriteOperation,
  type ClientSession,
  type Db,
  type Document,
  type Filter,
  type IndexSpecification,
} from "mongodb"
import type { z } from "zod"

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
import { assertWorkspace as assertSlug } from "../../workspace"
import { DuplicateIdError, StorageError } from "../errors"
import { Mutex } from "../mutex"
import type {
  AuditQuery,
  FolderQuery,
  HistoryQuery,
  ItemQuery,
  Page,
  Patch,
  Repositories,
  Storage,
  TubeQuery,
  WebhookDeliveryQuery,
} from "../types"

/**
 * MongoDB storage adapter: one collection per entity type in one database,
 * shared by any number of workspaces (MCPocket Cloud runs every tenant on the
 * same database).
 *
 * Layout: each document is the entity itself (readable in any Mongo tool)
 * plus `workspace` (the tenant; every read and write is scoped to it, and
 * `{workspace, id}` is unique, so two workspaces may hold the same entity ids)
 * and a few derived fields used for sorting and filtering: `_createdMs` (epoch
 * ms of `createdAt`, so timestamps with different UTC offsets compare
 * correctly), `_seq` (insertion order for ties, allocated per workspace from
 * the `counters` collection; updates keep it) and, for webhook deliveries,
 * `_nextAttemptMs`. `_id` is a plain ObjectId.
 *
 * Concurrency model (same guarantees as the JSON and SQLite adapters, and
 * like them it assumes ONE server process writes to a given workspace;
 * processes serving different workspaces may share the database):
 * - Transactions are serialised by an in-process FIFO mutex, one per
 *   workspace: workspaces never share documents (ids, `_seq` counters and
 *   every query are workspace-scoped), so their writes run concurrently. A
 *   lone repository write is an implicit one-operation transaction.
 * - A transaction buffers its writes in memory (an overlay keyed by id);
 *   reads inside it merge the overlay over the database, so they see their
 *   own writes. Reads outside a transaction go straight to MongoDB and only
 *   see committed data. Transaction context is tracked with
 *   AsyncLocalStorage, so nested calls join the active one.
 * - On commit the buffered writes are applied with one ordered `bulkWrite`
 *   per collection. On a replica set / sharded cluster the commit runs in a
 *   MongoDB multi-document transaction, so it is all-or-nothing. A
 *   standalone server has no multi-document transactions: if the process
 *   dies (or the server fails) mid-commit, an already-written collection is
 *   not rolled back. If `fn` throws, nothing is written on either topology.
 * - Writes use the connection string's write concern (e.g. `w=majority`).
 */

type Entity = { id: string; createdAt: string }

export type CollectionKey = keyof Dataset
type EntityOf<K extends CollectionKey> = Dataset[K][number]

/** Filter condition, translated both to a Mongo filter and a JS predicate. */
type Cond =
  | { kind: "eq"; field: string; value: string | null }
  | { kind: "in"; field: string; values: string[] }
  | { kind: "notDeleted" }
  | { kind: "dueBefore"; ms: number }

type CollectionDef<T> = {
  collection: string
  schema: z.ZodType<T>
  /** Secondary indexes (the created-order index is added for every collection). */
  indexes: IndexSpecification[]
}

const def = <T>(d: CollectionDef<T>) => d

const ORDER = { _createdMs: 1, _seq: 1 } as const

/** Entity collection → Mongo collection definition. */
export const COLLECTIONS = {
  folders: def({
    collection: "folders",
    schema: FolderSchema,
    indexes: [{ parentId: 1, ...ORDER }],
  }),
  tubes: def({
    collection: "tubes",
    schema: TubeSchema,
    indexes: [{ folderId: 1, ...ORDER }],
  }),
  items: def({
    collection: "items",
    schema: ItemSchema,
    indexes: [
      { tubeId: 1, status: 1, ...ORDER },
      { status: 1, ...ORDER },
      { assignedAgent: 1 },
      { tubeId: 1, idempotencyKey: 1 },
    ],
  }),
  history: def({
    collection: "history",
    schema: HistoryEventSchema,
    indexes: [{ itemId: 1, ...ORDER }, { actor: 1 }],
  }),
  apiKeys: def({
    collection: "api_keys",
    schema: ApiKeyRecordSchema,
    indexes: [],
  }),
  audit: def({
    collection: "audit",
    schema: AuditEventSchema,
    indexes: [{ targetType: 1, targetId: 1 }],
  }),
  webhooks: def({
    collection: "webhooks",
    schema: WebhookSchema,
    indexes: [],
  }),
  webhookDeliveries: def({
    collection: "webhook_deliveries",
    schema: WebhookDeliverySchema,
    indexes: [{ webhookId: 1 }, { status: 1, _nextAttemptMs: 1 }],
  }),
} satisfies { [K in CollectionKey]: CollectionDef<EntityOf<K>> }

/** Holds the per-collection `_seq` counters. */
export const COUNTERS = "counters"

/** Field holding the tenant of every document. */
export const WORKSPACE_FIELD = "workspace"

/** Validates a workspace slug; throws `StorageError`. */
export function assertWorkspace(workspace: string): string {
  try {
    return assertSlug(workspace)
  } catch (error) {
    throw new StorageError((error as Error).message)
  }
}

/** `counters` document id of a workspace's collection. */
const counterId = (workspace: string, collection: string) =>
  `${workspace}:${collection}`

const ms = (iso: string) => Date.parse(iso)
const META_FIELDS = [
  "_id",
  WORKSPACE_FIELD,
  "_seq",
  "_createdMs",
  "_nextAttemptMs",
]

/** Entity → stored document (entity fields + tenant + derived sort/filter fields). */
export function toDoc(
  entity: Entity,
  seq: number,
  workspace: string
): Document {
  const doc: Document = {
    ...entity,
    [WORKSPACE_FIELD]: workspace,
    _seq: seq,
    _createdMs: ms(entity.createdAt),
  }
  if ("nextAttemptAt" in entity) {
    const next = entity.nextAttemptAt as string | null
    doc._nextAttemptMs = next === null ? null : ms(next)
  }
  return doc
}

function fromDoc<T>(doc: Document): T {
  const entity: Document = { ...doc }
  for (const field of META_FIELDS) delete entity[field]
  return entity as T
}

/** Reserves `n` consecutive `_seq` values for a workspace's collection; returns the first. */
export async function allocateSeq(
  db: Db,
  workspace: string,
  collection: string,
  n: number,
  session?: ClientSession
): Promise<number> {
  const counter = await db
    .collection<{ _id: string; seq: number }>(COUNTERS)
    .findOneAndUpdate(
      { _id: counterId(workspace, collection) },
      { $inc: { seq: n } },
      { upsert: true, returnDocument: "after", session }
    )
  return counter!.seq - n + 1
}

/** Deletes a workspace's `_seq` counter of a collection (re-seed). */
export async function resetSeq(
  db: Db,
  workspace: string,
  collection: string,
  session?: ClientSession
): Promise<void> {
  await db
    .collection<{ _id: string }>(COUNTERS)
    .deleteOne({ _id: counterId(workspace, collection) }, { session })
}

/**
 * Creates the collections' indexes (idempotent). Every index starts with
 * `workspace`, since every query is scoped to one.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all(
    Object.values(COLLECTIONS).map(({ collection, indexes }) =>
      db.collection(collection).createIndexes([
        { key: { [WORKSPACE_FIELD]: 1, id: 1 }, unique: true },
        ...[ORDER, ...indexes].map((key) => ({
          key: { [WORKSPACE_FIELD]: 1, ...(key as Document) },
        })),
        // Managed API keys are looked up across workspaces (multi-workspace mode).
        ...(collection === COLLECTIONS.apiKeys.collection
          ? [{ key: { secretHash: 1 } as Document }]
          : []),
      ])
    )
  )
}

/** Mongo filter for a workspace's documents matching `conds`. */
function toFilter(workspace: string, conds: Cond[]): Filter<Document> {
  const parts: Filter<Document>[] = conds.map((c) => {
    switch (c.kind) {
      case "eq":
        // `null` also matches a missing field (like the other adapters).
        return { [c.field]: c.value }
      case "in":
        return { [c.field]: { $in: c.values } }
      case "notDeleted":
        return { deletedAt: null }
      case "dueBefore":
        return { _nextAttemptMs: { $ne: null, $lte: c.ms } }
    }
  })
  const scope: Filter<Document> = { [WORKSPACE_FIELD]: workspace }
  return parts.length ? { ...scope, $and: parts } : scope
}

function matches(entity: Record<string, unknown>, conds: Cond[]): boolean {
  return conds.every((c) => {
    switch (c.kind) {
      case "eq":
        return (entity[c.field] ?? null) === c.value
      case "in":
        return c.values.includes(entity[c.field] as string)
      case "notDeleted":
        return !entity.deletedAt
      case "dueBefore": {
        const next = entity.nextAttemptAt as string | null | undefined
        return next != null && ms(next) <= c.ms
      }
    }
  })
}

class Conds {
  readonly list: Cond[] = []

  eq(field: string, value: string | null | undefined): this {
    if (value !== undefined) this.list.push({ kind: "eq", field, value })
    return this
  }

  oneOf(field: string, value: string | string[] | undefined): this {
    if (value !== undefined) {
      this.list.push({
        kind: "in",
        field,
        values: Array.isArray(value) ? value : [value],
      })
    }
    return this
  }

  add(cond: Cond): this {
    this.list.push(cond)
    return this
  }
}

/** Applies a patch: `undefined` values remove the key; `id`/`createdAt` are kept. */
function applyPatch<T extends Entity>(existing: T, patch: Patch<T>): T {
  const next: Record<string, unknown> = { ...existing, ...patch }
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key]
  }
  next.id = existing.id
  next.createdAt = existing.createdAt
  return next as T
}

/** A buffered write: the entity's final state in the transaction (`null` = deleted). */
type Pending = {
  entity: Entity | null
  /** Whether the id exists in the database (decides insert vs replace/delete). */
  stored: boolean
  /** Stored `_seq` to keep on replace; undefined = allocate a new one. */
  seq?: number
  /** Position among this transaction's writes (orders new entities in reads). */
  order: number
}

type TxState = {
  /** Workspace the transaction writes to. */
  workspace: string
  closed: boolean
  writes: Map<CollectionKey, Map<string, Pending>>
  counter: number
}

type Located = { entity: Entity; seq: number; createdMs: number }

type Direction = 1 | -1

function paginate<T>(entities: T[], page: Page): T[] {
  const offset = Math.max(0, page.offset ?? 0)
  const end =
    page.limit === undefined ? undefined : offset + Math.max(0, page.limit)
  return entities.slice(offset, end)
}

const isDuplicateKey = (error: unknown) =>
  error instanceof MongoServerError && error.code === 11000

export type MongoStorageOptions = {
  /** Connection string, e.g. `mongodb://user:pass@host:27017/?w=majority`. */
  uri: string
  /** Database name. */
  dbName: string
  /** Tenant whose documents this instance reads and writes. */
  workspace: string
}

/** Opens a client; the caller owns (and must close) it. */
export async function connectMongo(uri: string): Promise<MongoClient> {
  const client = new MongoClient(uri, {
    ignoreUndefined: true,
    serverSelectionTimeoutMS: 10_000,
  })
  try {
    await client.connect()
  } catch (error) {
    await client.close().catch(() => undefined)
    throw new StorageError(
      `Cannot connect to MongoDB: ${(error as Error).message}`,
      { cause: error }
    )
  }
  return client
}

/** True on replica sets and sharded clusters (multi-document transactions). */
export async function supportsTransactions(db: Db): Promise<boolean> {
  const hello = await db.admin().command({ hello: 1 })
  return Boolean(hello.setName) || hello.msg === "isdbgrid"
}

export async function createMongoStorage(
  options: MongoStorageOptions
): Promise<MongoStorage> {
  const workspace = assertWorkspace(options.workspace)
  const client = await connectMongo(options.uri)
  try {
    const db = client.db(options.dbName)
    await ensureIndexes(db)
    return new MongoStorage(
      client,
      db,
      workspace,
      await supportsTransactions(db)
    )
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }
}

export class MongoStorage implements Storage {
  readonly driver = "mongo" as const
  readonly folders: Storage["folders"]
  readonly tubes: Storage["tubes"]
  readonly items: Storage["items"]
  readonly history: Storage["history"]
  readonly apiKeys: Storage["apiKeys"]
  readonly audit: Storage["audit"]
  readonly webhooks: Storage["webhooks"]
  readonly webhookDeliveries: Storage["webhookDeliveries"]

  /** This workspace's write lock (views are cached, one per workspace). */
  private readonly mutex = new Mutex()

  /** Shared by every workspace view of one connection. */
  private readonly shared: {
    context: AsyncLocalStorage<TxState>
    closed: boolean
    views: Map<string, MongoStorage>
  }

  constructor(
    private readonly client: MongoClient,
    readonly db: Db,
    /** Tenant every read and write is scoped to. */
    readonly workspace: string,
    /** Commit through a MongoDB multi-document transaction (replica sets). */
    readonly atomicCommit: boolean,
    shared?: MongoStorage["shared"]
  ) {
    this.shared = shared ?? {
      context: new AsyncLocalStorage<TxState>(),
      closed: false,
      views: new Map(),
    }
    this.shared.views.set(workspace, this)
    this.folders = {
      ...this.crud("folders"),
      list: (q: FolderQuery = {}) =>
        this.list("folders", this.folderConds(q), 1, q),
      count: (q: FolderQuery = {}) =>
        this.count("folders", this.folderConds(q)),
    }

    this.tubes = {
      ...this.crud("tubes"),
      list: (q: TubeQuery = {}) => this.list("tubes", this.tubeConds(q), 1, q),
      count: (q: TubeQuery = {}) => this.count("tubes", this.tubeConds(q)),
    }

    this.items = {
      ...this.crud("items"),
      list: (q: ItemQuery = {}) => this.list("items", this.itemConds(q), 1, q),
      count: (q: ItemQuery = {}) => this.count("items", this.itemConds(q)),
      findByIdempotencyKey: async (tubeId, key) => {
        const conds = new Conds()
          .eq("tubeId", tubeId)
          .eq("idempotencyKey", key).list
        const [first] = await this.list("items", conds, 1, { limit: 1 })
        return first ?? null
      },
    }

    this.history = {
      append: (event) => this.insert("history", event),
      list: (q: HistoryQuery = {}) =>
        this.list("history", this.historyConds(q), -1, q),
      count: (q: HistoryQuery = {}) =>
        this.count("history", this.historyConds(q)),
    }

    this.apiKeys = {
      ...this.crud("apiKeys"),
      list: (q: Page = {}) => this.list("apiKeys", [], 1, q),
      count: () => this.count("apiKeys", []),
    }

    this.audit = {
      append: (event) => this.insert("audit", event),
      list: (q: AuditQuery = {}) =>
        this.list("audit", this.auditConds(q), -1, q),
      count: (q: AuditQuery = {}) => this.count("audit", this.auditConds(q)),
    }

    this.webhooks = {
      ...this.crud("webhooks"),
      list: (q: Page = {}) => this.list("webhooks", [], 1, q),
      count: () => this.count("webhooks", []),
    }

    this.webhookDeliveries = {
      ...this.crud("webhookDeliveries"),
      list: (q: WebhookDeliveryQuery = {}) =>
        this.list(
          "webhookDeliveries",
          this.deliveryConds(q),
          q.newestFirst ? -1 : 1,
          q
        ),
      count: (q: WebhookDeliveryQuery = {}) =>
        this.count("webhookDeliveries", this.deliveryConds(q)),
    }
  }

  /**
   * The same storage scoped to another workspace: shares the connection,
   * has its own write lock (cached per workspace; closing any view closes
   * them all).
   */
  forWorkspace(workspace: string): MongoStorage {
    return (
      this.shared.views.get(workspace) ??
      new MongoStorage(
        this.client,
        this.db,
        assertWorkspace(workspace),
        this.atomicCommit,
        this.shared
      )
    )
  }

  /** Workspaces that hold at least one document of `name`. */
  async listWorkspaces(name: CollectionKey): Promise<string[]> {
    this.assertOpen()
    const values = await this.coll(name).distinct(WORKSPACE_FIELD)
    return values.filter((v): v is string => typeof v === "string").sort()
  }

  /** A managed API key with this secret hash, in any workspace. */
  async findApiKeyBySecretHash(
    secretHash: string
  ): Promise<{ workspace: string; key: EntityOf<"apiKeys"> } | null> {
    this.assertOpen()
    const doc = await this.coll("apiKeys").findOne({ secretHash })
    if (!doc || typeof doc[WORKSPACE_FIELD] !== "string") return null
    return {
      workspace: doc[WORKSPACE_FIELD],
      key: fromDoc<EntityOf<"apiKeys">>(doc),
    }
  }

  transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    if (this.activeTx()) return fn(this)

    return this.mutex.run(async () => {
      this.assertOpen()
      const tx: TxState = {
        workspace: this.workspace,
        closed: false,
        writes: new Map(),
        counter: 0,
      }
      try {
        const result = await this.shared.context.run(tx, () => fn(this))
        tx.closed = true
        await this.commit(tx)
        return result
      } finally {
        tx.closed = true
      }
    })
  }

  async close(): Promise<void> {
    if (this.shared.closed) return
    await Promise.all(
      [...this.shared.views.values()].map((v) => v.mutex.idle())
    )
    this.shared.closed = true
    await this.client.close()
  }

  // --- internals -----------------------------------------------------------

  private assertOpen(): void {
    if (this.shared.closed) throw new StorageError("MongoDB storage is closed")
  }

  private activeTx(): TxState | undefined {
    const tx = this.shared.context.getStore()
    if (!tx || tx.closed) return undefined
    // Joining would commit these writes to the other workspace; waiting for
    // the lock would deadlock.
    if (tx.workspace !== this.workspace) {
      throw new StorageError(
        `Workspace "${this.workspace}" accessed inside a transaction of workspace "${tx.workspace}"`
      )
    }
    return tx
  }

  private def<K extends CollectionKey>(name: K): CollectionDef<EntityOf<K>> {
    return COLLECTIONS[name] as unknown as CollectionDef<EntityOf<K>>
  }

  private coll(name: CollectionKey) {
    return this.db.collection(COLLECTIONS[name].collection)
  }

  /** Filter for one entity of this workspace. */
  private byId(id: string): Filter<Document> {
    return { [WORKSPACE_FIELD]: this.workspace, id }
  }

  /** The active transaction's pending writes for a collection (created on demand). */
  private overlay(tx: TxState, name: CollectionKey): Map<string, Pending> {
    let writes = tx.writes.get(name)
    if (!writes) {
      writes = new Map()
      tx.writes.set(name, writes)
    }
    return writes
  }

  /** Runs `fn` with the active transaction, or in a new one. */
  private write<R>(fn: (tx: TxState) => Promise<R>): Promise<R> {
    return this.transaction(async () => fn(this.activeTx()!))
  }

  /** Committed document by id (with its `_seq`). */
  private async locate(name: CollectionKey, id: string) {
    this.assertOpen()
    const doc = await this.coll(name).findOne(this.byId(id))
    return doc
      ? { entity: fromDoc<Entity>(doc), seq: doc._seq as number }
      : null
  }

  /** Entity as the current context sees it, plus where it is stored. */
  private async lookup(name: CollectionKey, id: string) {
    const pending = this.activeTx()?.writes.get(name)?.get(id)
    if (pending) {
      return {
        entity: pending.entity,
        stored: pending.stored,
        seq: pending.seq,
      }
    }
    const found = await this.locate(name, id)
    return { entity: found?.entity ?? null, stored: !!found, seq: found?.seq }
  }

  private async getById<K extends CollectionKey>(
    name: K,
    id: string
  ): Promise<EntityOf<K> | null> {
    const { entity } = await this.lookup(name, id)
    return entity ? (structuredClone(entity) as EntityOf<K>) : null
  }

  private async list<K extends CollectionKey>(
    name: K,
    conds: Cond[],
    dir: Direction,
    page: Page
  ): Promise<EntityOf<K>[]> {
    this.assertOpen()
    const filter = toFilter(this.workspace, conds)
    const pending = this.activeTx()?.writes.get(name)
    if (!pending?.size) {
      const offset = Math.max(0, page.offset ?? 0)
      let cursor = this.coll(name)
        .find(filter)
        .sort({ _createdMs: dir, _seq: dir })
        .skip(offset)
      if (page.limit !== undefined) {
        if (page.limit <= 0) return []
        cursor = cursor.limit(page.limit)
      }
      return (await cursor.toArray()).map((doc) => fromDoc<EntityOf<K>>(doc))
    }

    // Merge the transaction's writes over the committed documents.
    const docs = await this.coll(name)
      .find({ $and: [filter, { id: { $nin: [...pending.keys()] } }] })
      .toArray()
    const merged: Located[] = docs.map((doc) => ({
      entity: fromDoc<Entity>(doc),
      seq: doc._seq as number,
      createdMs: doc._createdMs as number,
    }))
    for (const p of pending.values()) {
      if (p.entity && matches(p.entity, conds)) {
        merged.push({
          entity: structuredClone(p.entity),
          // New entities sort after everything committed, in write order.
          seq: p.seq ?? Number.MAX_SAFE_INTEGER / 2 + p.order,
          createdMs: ms(p.entity.createdAt),
        })
      }
    }
    merged.sort((a, b) => dir * (a.createdMs - b.createdMs || a.seq - b.seq))
    return paginate(merged, page).map((m) => m.entity as EntityOf<K>)
  }

  private async count(name: CollectionKey, conds: Cond[]): Promise<number> {
    this.assertOpen()
    const filter = toFilter(this.workspace, conds)
    const pending = this.activeTx()?.writes.get(name)
    if (!pending?.size) return this.coll(name).countDocuments(filter)
    const committed = await this.coll(name).countDocuments({
      $and: [filter, { id: { $nin: [...pending.keys()] } }],
    })
    let buffered = 0
    for (const p of pending.values()) {
      if (p.entity && matches(p.entity, conds)) buffered++
    }
    return committed + buffered
  }

  private insert<K extends CollectionKey>(
    name: K,
    entity: EntityOf<K>
  ): Promise<EntityOf<K>> {
    return this.write(async (tx) => {
      const current = await this.lookup(name, entity.id)
      if (current.entity) throw new DuplicateIdError(name, entity.id)
      const stored = this.def(name).schema.parse(structuredClone(entity))
      this.overlay(tx, name).set(entity.id, {
        entity: stored,
        stored: current.stored,
        // Re-created after a delete in this transaction: new position.
        seq: undefined,
        order: tx.counter++,
      })
      return structuredClone(stored)
    })
  }

  private crud<K extends CollectionKey>(name: K) {
    type T = EntityOf<K>
    return {
      get: (id: string): Promise<T | null> => this.getById(name, id),
      create: (entity: T): Promise<T> => this.insert(name, entity),
      update: (id: string, patch: Patch<T>): Promise<T | null> =>
        this.write(async (tx) => {
          const current = await this.lookup(name, id)
          if (!current.entity) return null
          const stored = this.def(name).schema.parse(
            applyPatch(current.entity as T, structuredClone(patch) as Patch<T>)
          )
          const overlay = this.overlay(tx, name)
          overlay.set(id, {
            entity: stored,
            stored: current.stored,
            seq: current.seq,
            order: overlay.get(id)?.order ?? tx.counter++,
          })
          return structuredClone(stored)
        }),
      delete: (id: string): Promise<boolean> =>
        this.write(async (tx) => {
          const current = await this.lookup(name, id)
          if (!current.entity) return false
          const overlay = this.overlay(tx, name)
          overlay.set(id, {
            entity: null,
            stored: current.stored,
            seq: current.seq,
            order: overlay.get(id)?.order ?? tx.counter++,
          })
          return true
        }),
    }
  }

  /** Applies a transaction's buffered writes. */
  private async commit(tx: TxState): Promise<void> {
    if (![...tx.writes.values()].some((w) => w.size > 0)) return
    if (!this.atomicCommit) return this.applyWrites(tx)
    const session = this.client.startSession()
    try {
      await session.withTransaction(() => this.applyWrites(tx, session))
    } finally {
      await session.endSession()
    }
  }

  private async applyWrites(
    tx: TxState,
    session?: ClientSession
  ): Promise<void> {
    for (const name of Object.keys(COLLECTIONS) as CollectionKey[]) {
      const pending = tx.writes.get(name)
      if (!pending?.size) continue
      const { collection } = COLLECTIONS[name]
      const fresh = [...pending.values()].filter(
        (p) => p.entity && p.seq === undefined
      )
      let nextSeq = fresh.length
        ? await allocateSeq(
            this.db,
            this.workspace,
            collection,
            fresh.length,
            session
          )
        : 0

      const ops: AnyBulkWriteOperation<Document>[] = []
      const ordered = [...pending.entries()].sort(
        ([, a], [, b]) => a.order - b.order
      )
      for (const [id, p] of ordered) {
        if (!p.entity) {
          if (p.stored) ops.push({ deleteOne: { filter: this.byId(id) } })
          continue
        }
        const doc = toDoc(p.entity, p.seq ?? nextSeq++, this.workspace)
        ops.push(
          p.stored
            ? { replaceOne: { filter: this.byId(id), replacement: doc } }
            : { insertOne: { document: doc } }
        )
      }
      if (ops.length === 0) continue
      try {
        await this.coll(name).bulkWrite(ops, { ordered: true, session })
      } catch (error) {
        if (!isDuplicateKey(error)) throw error
        const id = ordered.find(([, p]) => p.entity && !p.stored)?.[0] ?? "?"
        throw new DuplicateIdError(name, id)
      }
    }
  }

  private folderConds(q: FolderQuery): Cond[] {
    return new Conds().eq("parentId", q.parentId).list
  }

  private tubeConds(q: TubeQuery): Cond[] {
    return new Conds().eq("folderId", q.folderId).list
  }

  private itemConds(q: ItemQuery): Cond[] {
    const conds = new Conds()
      .eq("tubeId", q.tubeId)
      .oneOf("status", q.status)
      .eq("assignedAgent", q.assignedAgent)
    if (!q.includeDeleted) conds.add({ kind: "notDeleted" })
    return conds.list
  }

  private historyConds(q: HistoryQuery): Cond[] {
    return new Conds().eq("itemId", q.itemId).eq("actor", q.actor).list
  }

  private auditConds(q: AuditQuery): Cond[] {
    return new Conds().eq("targetType", q.targetType).eq("targetId", q.targetId)
      .list
  }

  private deliveryConds(q: WebhookDeliveryQuery): Cond[] {
    const conds = new Conds()
      .eq("webhookId", q.webhookId)
      .oneOf("status", q.status)
    if (q.dueBefore !== undefined)
      conds.add({ kind: "dueBefore", ms: ms(q.dueBefore) })
    return conds.list
  }
}
