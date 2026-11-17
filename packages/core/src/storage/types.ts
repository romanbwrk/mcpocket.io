import type {
  ApiKeyRecord,
  AuditEvent,
  Folder,
  HistoryEvent,
  Item,
  ItemStatus,
  Tube,
  Webhook,
  WebhookDelivery,
  WebhookDeliveryStatus,
} from "../domain/schemas"

/**
 * Repository interface (plan §7). Application services talk only to these
 * interfaces; adapters (JSON, SQLite, later Mongo) implement them.
 *
 * Contract shared by every adapter (enforced by the contract test suite in
 * `lib/storage/testing/contract.ts`):
 * - `create` takes a complete, already-validated entity (services own id and
 *   timestamp generation) and rejects duplicate ids with `DuplicateIdError`.
 * - `update` applies a partial patch and returns the new entity, or `null`
 *   when the id does not exist. A key present with value `undefined` removes
 *   that optional field; `id` and `createdAt` are immutable.
 * - `delete` is a hard delete returning whether something was removed (item
 *   soft delete is a service concern: `update(id, { deletedAt })`).
 * - Returned entities are copies; mutating them never changes stored state.
 * - Every write is atomic and durable once the returned promise resolves.
 */

export type Patch<T extends { id: string; createdAt: string }> = Partial<
  Omit<T, "id" | "createdAt">
>

export type Page = {
  /** Number of matching entities to skip. Default 0. */
  offset?: number
  /** Maximum number of entities to return. Default: unlimited. */
  limit?: number
}

export interface CrudRepo<T extends { id: string; createdAt: string }> {
  get(id: string): Promise<T | null>
  create(entity: T): Promise<T>
  update(id: string, patch: Patch<T>): Promise<T | null>
  delete(id: string): Promise<boolean>
}

export type FolderQuery = Page & {
  /** `null` selects root folders; omit for all folders. */
  parentId?: string | null
}

/** Ordering: `createdAt` ascending, ties in insertion order. */
export interface FolderRepo extends CrudRepo<Folder> {
  list(query?: FolderQuery): Promise<Folder[]>
  count(query?: Omit<FolderQuery, keyof Page>): Promise<number>
}

export type TubeQuery = Page & {
  /** `null` selects top-level tubes (no folder); omit for all tubes. */
  folderId?: string | null
}

/** Ordering: `createdAt` ascending, ties in insertion order. */
export interface TubeRepo extends CrudRepo<Tube> {
  list(query?: TubeQuery): Promise<Tube[]>
  count(query?: Omit<TubeQuery, keyof Page>): Promise<number>
}

export type ItemQuery = Page & {
  tubeId?: string
  status?: ItemStatus | ItemStatus[]
  assignedAgent?: string
  /** Soft-deleted items (`deletedAt` set) are excluded unless true. */
  includeDeleted?: boolean
}

/** Ordering: `createdAt` ascending, ties in insertion order. */
export interface ItemRepo extends CrudRepo<Item> {
  list(query?: ItemQuery): Promise<Item[]>
  count(query?: Omit<ItemQuery, keyof Page>): Promise<number>
  /** Looks up an item by its per-tube idempotency key (deleted items included). */
  findByIdempotencyKey(tubeId: string, key: string): Promise<Item | null>
}

export type HistoryQuery = Page & {
  itemId?: string
  actor?: string
}

/** Append-only audit log. Ordering: newest first (`createdAt` desc, ties: last appended first). */
export interface HistoryRepo {
  append(event: HistoryEvent): Promise<HistoryEvent>
  list(query?: HistoryQuery): Promise<HistoryEvent[]>
  count(query?: Omit<HistoryQuery, keyof Page>): Promise<number>
}

/** API keys managed at runtime (ticket 16). Ordering: `createdAt` ascending. */
export interface ApiKeyRepo extends CrudRepo<ApiKeyRecord> {
  list(query?: Page): Promise<ApiKeyRecord[]>
  count(): Promise<number>
}

export type AuditQuery = Page & {
  targetType?: string
  targetId?: string
}

/** Append-only access audit log. Ordering: newest first (like history). */
export interface AuditRepo {
  append(event: AuditEvent): Promise<AuditEvent>
  list(query?: AuditQuery): Promise<AuditEvent[]>
  count(query?: Omit<AuditQuery, keyof Page>): Promise<number>
}

/** Webhook subscriptions (ticket 17). Ordering: `createdAt` ascending. */
export interface WebhookRepo extends CrudRepo<Webhook> {
  list(query?: Page): Promise<Webhook[]>
  count(): Promise<number>
}

export type WebhookDeliveryQuery = Page & {
  webhookId?: string
  status?: WebhookDeliveryStatus | WebhookDeliveryStatus[]
  /** Only deliveries whose `nextAttemptAt` is set and `<=` this ISO time. */
  dueBefore?: string
  /** Default: oldest first (`createdAt` asc); true: newest first. */
  newestFirst?: boolean
}

/** Webhook outbox / delivery log (ticket 17). */
export interface WebhookDeliveryRepo extends CrudRepo<WebhookDelivery> {
  list(query?: WebhookDeliveryQuery): Promise<WebhookDelivery[]>
  count(
    query?: Omit<WebhookDeliveryQuery, keyof Page | "newestFirst">
  ): Promise<number>
}

export interface Repositories {
  readonly folders: FolderRepo
  readonly tubes: TubeRepo
  readonly items: ItemRepo
  readonly history: HistoryRepo
  readonly apiKeys: ApiKeyRepo
  readonly audit: AuditRepo
  readonly webhooks: WebhookRepo
  readonly webhookDeliveries: WebhookDeliveryRepo
}

export type StorageDriver = "json" | "sqlite" | "mongo"

export interface Storage extends Repositories {
  readonly driver: StorageDriver

  /**
   * Runs `fn` as one exclusive, atomic unit of work: it is serialised with all
   * other writes, sees its own writes, and either all its writes are
   * committed (and persisted once) or none are, if `fn` throws.
   *
   * Use it for read-modify-write sequences (claim, item write + history
   * event, bulk ops). Repositories on `Storage` itself are transaction-aware,
   * so calling `storage.items.update(...)` inside `fn` joins the transaction;
   * nested `transaction()` calls join the outer one.
   */
  transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>

  /** Waits for pending writes and releases resources. */
  close(): Promise<void>

  // --- multi-workspace drivers only (MongoDB) -------------------------------

  /** Workspace this instance reads and writes (multi-workspace drivers). */
  readonly workspace?: string
  /** The same storage scoped to another workspace (shared connection, own write lock). */
  forWorkspace?(workspace: string): Storage
  /** Workspaces holding at least one document of a collection. */
  listWorkspaces?(collection: keyof Repositories): Promise<string[]>
  /** A managed API key by secret hash, in any workspace. */
  findApiKeyBySecretHash?(
    secretHash: string
  ): Promise<{ workspace: string; key: ApiKeyRecord } | null>
}
