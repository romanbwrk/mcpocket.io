import { AsyncLocalStorage } from "node:async_hooks"

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
import { DuplicateIdError } from "../errors"
import { Mutex } from "../mutex"
import type {
  ApiKeyRepo,
  AuditQuery,
  AuditRepo,
  FolderQuery,
  FolderRepo,
  HistoryQuery,
  HistoryRepo,
  ItemQuery,
  ItemRepo,
  Page,
  Patch,
  Repositories,
  Storage,
  TubeQuery,
  TubeRepo,
  WebhookDeliveryQuery,
  WebhookDeliveryRepo,
  WebhookRepo,
} from "../types"

import { readDataset, writeCollection, type CollectionName } from "./files"

/**
 * v1 storage adapter (plan §7.2): all data lives in memory, loaded once from
 * `<dataDir>/*.json`; every committed write re-persists the touched
 * collection files atomically (`*.tmp` + `rename`).
 *
 * Concurrency model:
 * - All writes run inside a transaction, and transactions are serialised by a
 *   single in-process FIFO mutex. A lone repository write is an implicit
 *   one-operation transaction.
 * - A transaction works on copy-on-write snapshots of the collections it
 *   touches. On success the touched files are persisted, then the snapshots
 *   are swapped in; if `fn` or persistence throws, nothing changes in memory.
 * - Reads outside a transaction see only committed state; reads inside one
 *   see its own uncommitted writes. Transaction context is tracked with
 *   AsyncLocalStorage, so nested calls join the active transaction.
 *
 * Single process only: two processes sharing a data directory will overwrite
 * each other's writes.
 */

type Collections = {
  folders: Map<string, Folder>
  tubes: Map<string, Tube>
  items: Map<string, Item>
  history: Map<string, HistoryEvent>
  apiKeys: Map<string, ApiKeyRecord>
  audit: Map<string, AuditEvent>
  webhooks: Map<string, Webhook>
  webhookDeliveries: Map<string, WebhookDelivery>
}

type TxState = {
  working: Partial<Collections>
  closed: boolean
}

export type JsonStorageOptions = {
  /** Directory holding `folders.json`, `tubes.json`, `items.json`, `history.json`, `api-keys.json`, `audit.json`, `webhooks.json`, `webhook-deliveries.json`. */
  dataDir: string
}

export async function createJsonStorage(
  options: JsonStorageOptions
): Promise<JsonStorage> {
  const dataset = await readDataset(options.dataDir)
  return new JsonStorage(options.dataDir, dataset)
}

const clone = <T>(value: T): T => structuredClone(value)

const toMap = <T extends { id: string }>(entities: T[]): Map<string, T> =>
  new Map(entities.map((entity) => [entity.id, entity]))

const time = (iso: string) => Date.parse(iso)

function paginate<T>(entities: T[], page: Page): T[] {
  const offset = Math.max(0, page.offset ?? 0)
  const end =
    page.limit === undefined ? undefined : offset + Math.max(0, page.limit)
  return entities.slice(offset, end)
}

/** Applies a patch: `undefined` values remove the key; `id`/`createdAt` are kept. */
function applyPatch<T extends { id: string; createdAt: string }>(
  existing: T,
  patch: Patch<T>
): T {
  const next: Record<string, unknown> = { ...existing, ...patch }
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key]
  }
  next.id = existing.id
  next.createdAt = existing.createdAt
  return next as T
}

export class JsonStorage implements Storage {
  readonly driver = "json" as const
  readonly folders: FolderRepo
  readonly tubes: TubeRepo
  readonly items: ItemRepo
  readonly history: HistoryRepo
  readonly apiKeys: ApiKeyRepo
  readonly audit: AuditRepo
  readonly webhooks: WebhookRepo
  readonly webhookDeliveries: WebhookDeliveryRepo

  private committed: Collections
  private readonly mutex = new Mutex()
  private readonly context = new AsyncLocalStorage<TxState>()

  constructor(
    readonly dataDir: string,
    dataset: Dataset
  ) {
    this.committed = {
      folders: toMap(dataset.folders),
      tubes: toMap(dataset.tubes),
      items: toMap(dataset.items),
      history: toMap(dataset.history),
      apiKeys: toMap(dataset.apiKeys),
      audit: toMap(dataset.audit),
      webhooks: toMap(dataset.webhooks),
      webhookDeliveries: toMap(dataset.webhookDeliveries),
    }

    this.folders = {
      ...this.crud<Folder>("folders", FolderSchema),
      list: async (query: FolderQuery = {}) =>
        paginate(this.selectFolders(query), query).map(clone),
      count: async (query: FolderQuery = {}) =>
        this.selectFolders(query).length,
    }

    this.tubes = {
      ...this.crud<Tube>("tubes", TubeSchema),
      list: async (query: TubeQuery = {}) =>
        paginate(this.selectTubes(query), query).map(clone),
      count: async (query: TubeQuery = {}) => this.selectTubes(query).length,
    }

    this.items = {
      ...this.crud<Item>("items", ItemSchema),
      list: async (query: ItemQuery = {}) =>
        paginate(this.selectItems(query), query).map(clone),
      count: async (query: ItemQuery = {}) => this.selectItems(query).length,
      findByIdempotencyKey: async (tubeId, key) => {
        for (const item of this.view("items").values()) {
          if (item.tubeId === tubeId && item.idempotencyKey === key)
            return clone(item)
        }
        return null
      },
    }

    this.history = {
      append: (event) =>
        this.write((tx) => {
          const history = this.mutable(tx, "history")
          if (history.has(event.id))
            throw new DuplicateIdError("history", event.id)
          const stored = HistoryEventSchema.parse(clone(event))
          history.set(stored.id, stored)
          return clone(stored)
        }),
      list: async (query: HistoryQuery = {}) =>
        paginate(this.selectHistory(query), query).map(clone),
      count: async (query: HistoryQuery = {}) =>
        this.selectHistory(query).length,
    }

    this.apiKeys = {
      ...this.crud<ApiKeyRecord>("apiKeys", ApiKeyRecordSchema),
      list: async (query: Page = {}) =>
        paginate(this.sorted(this.view("apiKeys").values()), query).map(clone),
      count: async () => this.view("apiKeys").size,
    }

    this.audit = {
      append: (event) =>
        this.write((tx) => {
          const audit = this.mutable(tx, "audit")
          if (audit.has(event.id)) throw new DuplicateIdError("audit", event.id)
          const stored = AuditEventSchema.parse(clone(event))
          audit.set(stored.id, stored)
          return clone(stored)
        }),
      list: async (query: AuditQuery = {}) =>
        paginate(this.selectAudit(query), query).map(clone),
      count: async (query: AuditQuery = {}) => this.selectAudit(query).length,
    }

    this.webhooks = {
      ...this.crud<Webhook>("webhooks", WebhookSchema),
      list: async (query: Page = {}) =>
        paginate(this.sorted(this.view("webhooks").values()), query).map(clone),
      count: async () => this.view("webhooks").size,
    }

    this.webhookDeliveries = {
      ...this.crud<WebhookDelivery>("webhookDeliveries", WebhookDeliverySchema),
      list: async (query: WebhookDeliveryQuery = {}) =>
        paginate(this.selectDeliveries(query), query).map(clone),
      count: async (query: WebhookDeliveryQuery = {}) =>
        this.selectDeliveries(query).length,
    }
  }

  transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    const active = this.activeTx()
    if (active) return fn(this)

    return this.mutex.run(async () => {
      const tx: TxState = { working: {}, closed: false }
      try {
        const result = await this.context.run(tx, () => fn(this))
        await this.commit(tx)
        return result
      } finally {
        tx.closed = true
      }
    })
  }

  async close(): Promise<void> {
    await this.mutex.idle()
  }

  // --- internals -----------------------------------------------------------

  private activeTx(): TxState | undefined {
    const tx = this.context.getStore()
    return tx && !tx.closed ? tx : undefined
  }

  /** The collection as seen by the caller: the transaction's copy if any. */
  private view<K extends CollectionName>(name: K): Collections[K] {
    const tx = this.activeTx()
    return (
      (tx?.working[name] as Collections[K] | undefined) ?? this.committed[name]
    )
  }

  /** Copy-on-write: the transaction's private, writable copy of a collection. */
  private mutable<K extends CollectionName>(
    tx: TxState,
    name: K
  ): Collections[K] {
    let working = tx.working[name] as Collections[K] | undefined
    if (!working) {
      working = new Map(
        this.committed[name] as Map<string, unknown>
      ) as Collections[K]
      tx.working[name] = working as never
    }
    return working
  }

  /** Runs a synchronous mutation in the active transaction, or in a new one. */
  private write<R>(mutate: (tx: TxState) => R): Promise<R> {
    return this.transaction(async () => mutate(this.activeTx()!))
  }

  private async commit(tx: TxState): Promise<void> {
    const names = Object.keys(tx.working) as CollectionName[]
    if (names.length === 0) return
    // allSettled, not all: every write must have finished before a rollback
    // starts, or a still-running write could land after (and overwrite) the
    // restored file, or touch the directory after the caller moved on.
    const results = await Promise.allSettled(
      names.map((name) =>
        writeCollection(this.dataDir, name, [
          ...tx.working[name]!.values(),
        ] as never)
      )
    )
    const failure = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    )
    if (failure) {
      // Best effort: put the files we may have replaced back to committed state.
      await Promise.allSettled(
        names.map((name) =>
          writeCollection(this.dataDir, name, [
            ...this.committed[name].values(),
          ] as never)
        )
      )
      throw failure.reason
    }
    for (const name of names) {
      this.committed[name] = tx.working[name] as never
    }
  }

  private crud<T extends { id: string; createdAt: string }>(
    name:
      | "folders"
      | "tubes"
      | "items"
      | "apiKeys"
      | "webhooks"
      | "webhookDeliveries",
    schema: z.ZodType<T>
  ) {
    const read = () => this.view(name) as unknown as Map<string, T>
    const writable = (tx: TxState) =>
      this.mutable(tx, name) as unknown as Map<string, T>
    return {
      get: async (id: string): Promise<T | null> => {
        const entity = read().get(id)
        return entity ? clone(entity) : null
      },
      create: (entity: T): Promise<T> =>
        this.write((tx) => {
          const map = writable(tx)
          if (map.has(entity.id)) throw new DuplicateIdError(name, entity.id)
          const stored = schema.parse(clone(entity))
          map.set(stored.id, stored)
          return clone(stored)
        }),
      update: (id: string, patch: Patch<T>): Promise<T | null> =>
        this.write((tx) => {
          const existing = read().get(id)
          if (!existing) return null
          const stored = schema.parse(applyPatch(existing, clone(patch)))
          writable(tx).set(id, stored)
          return clone(stored)
        }),
      delete: (id: string): Promise<boolean> =>
        this.write((tx) => {
          if (!read().has(id)) return false
          return writable(tx).delete(id)
        }),
    }
  }

  private sorted<T extends { createdAt: string }>(entities: Iterable<T>): T[] {
    // Array.prototype.sort is stable, so ties keep insertion order.
    return [...entities].sort((a, b) => time(a.createdAt) - time(b.createdAt))
  }

  private selectFolders(query: FolderQuery): Folder[] {
    const all = this.sorted(this.view("folders").values())
    return all.filter(
      (f) => query.parentId === undefined || f.parentId === query.parentId
    )
  }

  private selectTubes(query: TubeQuery): Tube[] {
    const all = this.sorted(this.view("tubes").values())
    return all.filter(
      (t) => query.folderId === undefined || t.folderId === query.folderId
    )
  }

  private selectItems(query: ItemQuery): Item[] {
    const statuses =
      query.status === undefined
        ? undefined
        : new Set(Array.isArray(query.status) ? query.status : [query.status])
    return this.sorted(this.view("items").values()).filter(
      (item) =>
        (query.tubeId === undefined || item.tubeId === query.tubeId) &&
        (statuses === undefined || statuses.has(item.status)) &&
        (query.assignedAgent === undefined ||
          item.assignedAgent === query.assignedAgent) &&
        (query.includeDeleted || !item.deletedAt)
    )
  }

  private selectDeliveries(query: WebhookDeliveryQuery): WebhookDelivery[] {
    const statuses =
      query.status === undefined
        ? undefined
        : new Set(Array.isArray(query.status) ? query.status : [query.status])
    const due =
      query.dueBefore === undefined ? undefined : time(query.dueBefore)
    const all = this.sorted(this.view("webhookDeliveries").values())
    if (query.newestFirst) all.reverse()
    return all.filter(
      (d) =>
        (query.webhookId === undefined || d.webhookId === query.webhookId) &&
        (statuses === undefined || statuses.has(d.status)) &&
        (due === undefined ||
          (d.nextAttemptAt !== null && time(d.nextAttemptAt) <= due))
    )
  }

  private selectAudit(query: AuditQuery): AuditEvent[] {
    return [...this.view("audit").values()]
      .reverse()
      .sort((a, b) => time(b.createdAt) - time(a.createdAt))
      .filter(
        (event) =>
          (query.targetType === undefined ||
            event.targetType === query.targetType) &&
          (query.targetId === undefined || event.targetId === query.targetId)
      )
  }

  private selectHistory(query: HistoryQuery): HistoryEvent[] {
    // Newest first; reversing before the stable sort makes ties "last appended first".
    return [...this.view("history").values()]
      .reverse()
      .sort((a, b) => time(b.createdAt) - time(a.createdAt))
      .filter(
        (event) =>
          (query.itemId === undefined || event.itemId === query.itemId) &&
          (query.actor === undefined || event.actor === query.actor)
      )
  }
}
