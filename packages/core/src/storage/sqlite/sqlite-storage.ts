import { AsyncLocalStorage } from "node:async_hooks"
import { mkdirSync } from "node:fs"
import path from "node:path"
import type { DatabaseSync, SQLInputValue } from "node:sqlite"

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
  type ApiKeyRecord,
  type AuditEvent,
  type Dataset,
  type Folder,
  type HistoryEvent,
  type Item,
  type Tube,
  type Webhook,
  type WebhookDelivery,
} from "../../domain/schemas"
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
 * SQLite storage adapter: one database file (default `<DATA_DIR>/mcpocket.db`),
 * via Node's built-in `node:sqlite` — no native dependency, no extra service.
 *
 * Layout: one table per collection. Each row stores the whole entity as JSON
 * (`doc`) plus a few indexed columns derived from it for filtering/sorting
 * (`created_ms` etc. hold epoch milliseconds, so timestamps with different
 * UTC offsets compare correctly). `seq` (AUTOINCREMENT) records insertion
 * order for ties; updates keep the row, so they keep their position.
 *
 * Concurrency model (same guarantees as the JSON adapter):
 * - Writes run in transactions serialised by an in-process FIFO mutex on a
 *   dedicated writer connection (`BEGIN IMMEDIATE`, so other processes such
 *   as `npm run seed` are locked out rather than interleaved).
 * - Reads outside a transaction use a second connection; with WAL it only
 *   ever sees committed state. Reads inside a transaction use the writer
 *   connection and see their own uncommitted writes. Transaction context is
 *   tracked with AsyncLocalStorage, so nested calls join the active one.
 * - `synchronous = FULL`: a write is durable once its promise resolves.
 */

type Sqlite = typeof import("node:sqlite")

/**
 * Loaded at runtime instead of a static import: `node:sqlite` is a
 * prefix-only builtin that bundlers do not all recognise.
 */
function loadSqlite(): Sqlite {
  const mod = process.getBuiltinModule?.("node:sqlite") as Sqlite | undefined
  if (!mod) {
    throw new StorageError(
      'STORAGE_DRIVER "sqlite" needs Node.js >= 22.13 (built-in node:sqlite)'
    )
  }
  return mod
}

type Entity = { id: string; createdAt: string }
type Row = { doc: string }

export type TableName = keyof Dataset

/** Indexed columns derived from an entity (besides id / created_ms / doc). */
type ColumnDef<T> = Record<string, (entity: T) => SQLInputValue>

const ms = (iso: string) => Date.parse(iso)

type TableDef<T> = {
  table: string
  schema: z.ZodType<T>
  columns: ColumnDef<T>
  indexes: string[][]
}

const def = <T>(d: TableDef<T>) => d

/** Collection → table definition. Column getters must be pure. */
export const TABLES = {
  folders: def<Folder>({
    table: "folders",
    schema: FolderSchema,
    columns: { parent_id: (f) => f.parentId },
    indexes: [["parent_id", "created_ms"]],
  }),
  tubes: def<Tube>({
    table: "tubes",
    schema: TubeSchema,
    columns: { folder_id: (t) => t.folderId },
    indexes: [["folder_id", "created_ms"]],
  }),
  items: def<Item>({
    table: "items",
    schema: ItemSchema,
    columns: {
      tube_id: (i) => i.tubeId,
      status: (i) => i.status,
      assigned_agent: (i) => i.assignedAgent ?? null,
      idempotency_key: (i) => i.idempotencyKey ?? null,
      deleted: (i) => (i.deletedAt ? 1 : 0),
    },
    indexes: [
      ["tube_id", "status", "created_ms"],
      ["status", "created_ms"],
      ["assigned_agent"],
      ["tube_id", "idempotency_key"],
    ],
  }),
  history: def<HistoryEvent>({
    table: "history",
    schema: HistoryEventSchema,
    columns: { item_id: (h) => h.itemId, actor: (h) => h.actor },
    indexes: [["item_id", "created_ms"], ["actor"]],
  }),
  apiKeys: def<ApiKeyRecord>({
    table: "api_keys",
    schema: ApiKeyRecordSchema,
    columns: {},
    indexes: [],
  }),
  audit: def<AuditEvent>({
    table: "audit",
    schema: AuditEventSchema,
    columns: {
      target_type: (a) => a.targetType,
      target_id: (a) => a.targetId,
    },
    indexes: [["target_type", "target_id"]],
  }),
  webhooks: def<Webhook>({
    table: "webhooks",
    schema: WebhookSchema,
    columns: {},
    indexes: [],
  }),
  webhookDeliveries: def<WebhookDelivery>({
    table: "webhook_deliveries",
    schema: WebhookDeliverySchema,
    columns: {
      webhook_id: (d) => d.webhookId,
      status: (d) => d.status,
      next_attempt_ms: (d) =>
        d.nextAttemptAt === null ? null : ms(d.nextAttemptAt),
    },
    indexes: [["webhook_id"], ["status", "next_attempt_ms"]],
  }),
} satisfies { [K in TableName]: TableDef<Dataset[K][number]> }

type EntityOf<K extends TableName> = Dataset[K][number]

const SCHEMA_VERSION = 1

function migrate(db: DatabaseSync): void {
  const version = (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version
  if (version > SCHEMA_VERSION) {
    throw new StorageError(
      `SQLite schema version ${version} is newer than this build supports (${SCHEMA_VERSION})`
    )
  }
  if (version === SCHEMA_VERSION) return
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const { table, columns, indexes } of Object.values(TABLES)) {
      const extra = Object.keys(columns).map((c) => `, ${c}`)
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          created_ms INTEGER NOT NULL,
          doc TEXT NOT NULL${extra.join("")}
        )`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS ${table}_created ON ${table} (created_ms, seq)`
      )
      for (const cols of indexes) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS ${table}_${cols.join("_")} ON ${table} (${cols.join(", ")})`
        )
      }
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

function openConnection(file: string, readOnly: boolean): DatabaseSync {
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(file, { readOnly })
  db.exec("PRAGMA busy_timeout = 5000")
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA synchronous = FULL")
  }
  return db
}

/** Opens (creating if needed) a writer connection with the schema in place. */
export function openSqliteDatabase(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true })
  const db = openConnection(file, false)
  try {
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}

/** Inserts entities (already validated) into a collection's table. */
export function insertRows<K extends TableName>(
  db: DatabaseSync,
  name: K,
  entities: EntityOf<K>[]
): void {
  const { table, columns } = TABLES[name] as unknown as TableDef<EntityOf<K>>
  const cols = Object.keys(columns)
  const stmt = db.prepare(
    `INSERT INTO ${table} (id, created_ms, doc${cols.map((c) => `, ${c}`).join("")})
     VALUES (?, ?, ?${cols.map(() => ", ?").join("")})`
  )
  for (const entity of entities) {
    stmt.run(
      entity.id,
      ms(entity.createdAt),
      JSON.stringify(entity),
      ...cols.map((c) => columns[c](entity))
    )
  }
}

export type SqliteStorageOptions = {
  /** Database file, e.g. `<DATA_DIR>/mcpocket.db`. Created if missing. */
  file: string
}

export async function createSqliteStorage(
  options: SqliteStorageOptions
): Promise<SqliteStorage> {
  const writer = openSqliteDatabase(options.file)
  let reader: DatabaseSync
  try {
    reader = openConnection(options.file, true)
  } catch (error) {
    writer.close()
    throw error
  }
  return new SqliteStorage(options.file, writer, reader)
}

type TxState = { closed: boolean }

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

/** WHERE-clause builder. */
class Where {
  readonly parts: string[] = []
  readonly params: SQLInputValue[] = []

  eq(column: string, value: string | null | undefined): this {
    if (value === undefined) return this
    if (value === null) this.parts.push(`${column} IS NULL`)
    else {
      this.parts.push(`${column} = ?`)
      this.params.push(value)
    }
    return this
  }

  oneOf(column: string, value: string | string[] | undefined): this {
    if (value === undefined) return this
    const values = Array.isArray(value) ? value : [value]
    if (values.length === 0) this.parts.push("0")
    else {
      this.parts.push(`${column} IN (${values.map(() => "?").join(", ")})`)
      this.params.push(...values)
    }
    return this
  }

  raw(sql: string, ...params: SQLInputValue[]): this {
    this.parts.push(sql)
    this.params.push(...params)
    return this
  }

  toString(): string {
    return this.parts.length ? ` WHERE ${this.parts.join(" AND ")}` : ""
  }
}

const ASC = " ORDER BY created_ms ASC, seq ASC"
const DESC = " ORDER BY created_ms DESC, seq DESC"

function limitClause(page: Page): { sql: string; params: number[] } {
  const offset = Math.max(0, page.offset ?? 0)
  const limit = page.limit === undefined ? -1 : Math.max(0, page.limit)
  return { sql: " LIMIT ? OFFSET ?", params: [limit, offset] }
}

export class SqliteStorage implements Storage {
  readonly driver = "sqlite" as const
  readonly folders: Storage["folders"]
  readonly tubes: Storage["tubes"]
  readonly items: Storage["items"]
  readonly history: Storage["history"]
  readonly apiKeys: Storage["apiKeys"]
  readonly audit: Storage["audit"]
  readonly webhooks: Storage["webhooks"]
  readonly webhookDeliveries: Storage["webhookDeliveries"]

  private readonly mutex = new Mutex()
  private readonly context = new AsyncLocalStorage<TxState>()
  private closed = false

  constructor(
    readonly file: string,
    private readonly writer: DatabaseSync,
    private readonly reader: DatabaseSync
  ) {
    this.folders = {
      ...this.crud("folders"),
      list: async (q: FolderQuery = {}) =>
        this.list("folders", this.folderWhere(q), ASC, q),
      count: async (q: FolderQuery = {}) =>
        this.count("folders", this.folderWhere(q)),
    }

    this.tubes = {
      ...this.crud("tubes"),
      list: async (q: TubeQuery = {}) =>
        this.list("tubes", this.tubeWhere(q), ASC, q),
      count: async (q: TubeQuery = {}) =>
        this.count("tubes", this.tubeWhere(q)),
    }

    this.items = {
      ...this.crud("items"),
      list: async (q: ItemQuery = {}) =>
        this.list("items", this.itemWhere(q), ASC, q),
      count: async (q: ItemQuery = {}) =>
        this.count("items", this.itemWhere(q)),
      findByIdempotencyKey: async (tubeId, key) =>
        this.first(
          "items",
          new Where().eq("tube_id", tubeId).eq("idempotency_key", key)
        ),
    }

    this.history = {
      append: (event) => this.insert("history", event),
      list: async (q: HistoryQuery = {}) =>
        this.list("history", this.historyWhere(q), DESC, q),
      count: async (q: HistoryQuery = {}) =>
        this.count("history", this.historyWhere(q)),
    }

    this.apiKeys = {
      ...this.crud("apiKeys"),
      list: async (q: Page = {}) => this.list("apiKeys", new Where(), ASC, q),
      count: async () => this.count("apiKeys", new Where()),
    }

    this.audit = {
      append: (event) => this.insert("audit", event),
      list: async (q: AuditQuery = {}) =>
        this.list("audit", this.auditWhere(q), DESC, q),
      count: async (q: AuditQuery = {}) =>
        this.count("audit", this.auditWhere(q)),
    }

    this.webhooks = {
      ...this.crud("webhooks"),
      list: async (q: Page = {}) => this.list("webhooks", new Where(), ASC, q),
      count: async () => this.count("webhooks", new Where()),
    }

    this.webhookDeliveries = {
      ...this.crud("webhookDeliveries"),
      list: async (q: WebhookDeliveryQuery = {}) =>
        this.list(
          "webhookDeliveries",
          this.deliveryWhere(q),
          q.newestFirst ? DESC : ASC,
          q
        ),
      count: async (q: WebhookDeliveryQuery = {}) =>
        this.count("webhookDeliveries", this.deliveryWhere(q)),
    }
  }

  transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    if (this.activeTx()) return fn(this)

    return this.mutex.run(async () => {
      this.assertOpen()
      const tx: TxState = { closed: false }
      this.writer.exec("BEGIN IMMEDIATE")
      try {
        const result = await this.context.run(tx, () => fn(this))
        tx.closed = true
        this.writer.exec("COMMIT")
        return result
      } catch (error) {
        tx.closed = true
        if (this.writer.isTransaction) this.writer.exec("ROLLBACK")
        throw error
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.mutex.idle()
    this.closed = true
    this.reader.close()
    this.writer.close()
  }

  // --- internals -----------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new StorageError("SQLite storage is closed")
  }

  private activeTx(): TxState | undefined {
    const tx = this.context.getStore()
    return tx && !tx.closed ? tx : undefined
  }

  /** Connection for reads: the writer inside a transaction, else the reader. */
  private db(): DatabaseSync {
    this.assertOpen()
    return this.activeTx() ? this.writer : this.reader
  }

  /** Runs a synchronous mutation in the active transaction, or in a new one. */
  private write<R>(mutate: () => R): Promise<R> {
    return this.transaction(async () => mutate())
  }

  private def<K extends TableName>(name: K): TableDef<EntityOf<K>> {
    return TABLES[name] as unknown as TableDef<EntityOf<K>>
  }

  private list<K extends TableName>(
    name: K,
    where: Where,
    order: string,
    page: Page
  ): EntityOf<K>[] {
    const limit = limitClause(page)
    const rows = this.db()
      .prepare(
        `SELECT doc FROM ${this.def(name).table}${where}${order}${limit.sql}`
      )
      .all(...where.params, ...limit.params) as Row[]
    return rows.map((row) => JSON.parse(row.doc) as EntityOf<K>)
  }

  private count<K extends TableName>(name: K, where: Where): number {
    const row = this.db()
      .prepare(`SELECT COUNT(*) AS n FROM ${this.def(name).table}${where}`)
      .get(...where.params) as { n: number }
    return Number(row.n)
  }

  private first<K extends TableName>(
    name: K,
    where: Where
  ): EntityOf<K> | null {
    const row = this.db()
      .prepare(`SELECT doc FROM ${this.def(name).table}${where}${ASC} LIMIT 1`)
      .get(...where.params) as Row | undefined
    return row ? (JSON.parse(row.doc) as EntityOf<K>) : null
  }

  private getById<K extends TableName>(name: K, id: string) {
    return this.first(name, new Where().eq("id", id))
  }

  private insert<K extends TableName>(
    name: K,
    entity: EntityOf<K>
  ): Promise<EntityOf<K>> {
    return this.write(() => {
      if (this.getById(name, entity.id))
        throw new DuplicateIdError(name, entity.id)
      const stored = this.def(name).schema.parse(structuredClone(entity))
      insertRows(this.writer, name, [stored])
      return structuredClone(stored)
    })
  }

  private crud<K extends TableName>(name: K) {
    type T = EntityOf<K>
    const { table, schema, columns } = this.def(name)
    const cols = Object.keys(columns)
    return {
      get: async (id: string): Promise<T | null> => this.getById(name, id),
      create: (entity: T): Promise<T> => this.insert(name, entity),
      update: (id: string, patch: Patch<T>): Promise<T | null> =>
        this.write(() => {
          const existing = this.getById(name, id)
          if (!existing) return null
          const stored = schema.parse(
            applyPatch(existing, structuredClone(patch) as Patch<T>)
          )
          this.writer
            .prepare(
              `UPDATE ${table} SET doc = ?${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ?`
            )
            .run(
              JSON.stringify(stored),
              ...cols.map((c) => columns[c](stored)),
              id
            )
          return structuredClone(stored)
        }),
      delete: (id: string): Promise<boolean> =>
        this.write(
          () =>
            Number(
              this.writer.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
                .changes
            ) > 0
        ),
    }
  }

  private folderWhere(q: FolderQuery): Where {
    return new Where().eq("parent_id", q.parentId)
  }

  private tubeWhere(q: TubeQuery): Where {
    return new Where().eq("folder_id", q.folderId)
  }

  private itemWhere(q: ItemQuery): Where {
    const where = new Where()
      .eq("tube_id", q.tubeId)
      .oneOf("status", q.status)
      .eq("assigned_agent", q.assignedAgent)
    if (!q.includeDeleted) where.raw("deleted = 0")
    return where
  }

  private historyWhere(q: HistoryQuery): Where {
    return new Where().eq("item_id", q.itemId).eq("actor", q.actor)
  }

  private auditWhere(q: AuditQuery): Where {
    return new Where()
      .eq("target_type", q.targetType)
      .eq("target_id", q.targetId)
  }

  private deliveryWhere(q: WebhookDeliveryQuery): Where {
    const where = new Where()
      .eq("webhook_id", q.webhookId)
      .oneOf("status", q.status)
    if (q.dueBefore !== undefined) {
      where.raw(
        "next_attempt_ms IS NOT NULL AND next_attempt_ms <= ?",
        ms(q.dueBefore)
      )
    }
    return where
  }
}
