import { z } from "zod"

import type { Actor } from "../domain/actor"
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors"
import { assertValidJsonSchema } from "../domain/json-schema"
import {
  RetryPolicyInputSchema,
  type RetryPolicy,
} from "../domain/retry-policy"
import { PageInputSchema, type PageResult } from "../domain/pagination"
import {
  IdSchema,
  LeaseSecondsSchema,
  MAX_NEXT_TUBES,
  TubeSchema,
  type Tube,
} from "../domain/schemas"
import type { Patch, Repositories } from "../storage"

import { createAccessControl } from "./access"
import type { ServiceContext } from "./context"
import { emit, itemEvent, transact, tubeEvent } from "./events"
import { recordHistory } from "./history"

const NameSchema = TubeSchema.shape.name
const DescriptionSchema = z.string().max(2000)
/** JSON Schema object; checked for validity by `assertValidJsonSchema`. */
const SchemaDefinitionSchema = z.record(z.string(), z.unknown())

/** Folder reference; `null` = top level (no folder). */
const FolderRefSchema = IdSchema.nullable()

/** Pipeline hand-off targets (distinct, existing tubes, not the tube itself). */
const NextTubeIdsSchema = z
  .array(IdSchema)
  .max(MAX_NEXT_TUBES)
  .transform((ids) => [...new Set(ids)])

export const CreateTubeInputSchema = z.strictObject({
  /** Containing folder; omit or `null` for a top-level tube. */
  folderId: FolderRefSchema.default(null),
  name: NameSchema,
  description: DescriptionSchema.optional(),
  enabled: z.boolean().default(true),
  /** Optional JSON Schema that item payloads must satisfy. */
  schemaDefinition: SchemaDefinitionSchema.optional(),
  /** Retry overrides (maxAttempts, backoff, delaySeconds, maxDelaySeconds). */
  retryPolicy: RetryPolicyInputSchema.optional(),
  /** Default lease seconds for this tube's claims / heartbeats. */
  leaseSeconds: LeaseSecondsSchema.optional(),
  /** Tubes this stage hands its output to (`complete_item` `next`). */
  nextTubeIds: NextTubeIdsSchema.optional(),
})
export type CreateTubeInput = z.input<typeof CreateTubeInputSchema>

export const UpdateTubeInputSchema = z
  .strictObject({
    name: NameSchema.optional(),
    /** `null` clears the description. */
    description: DescriptionSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    /** `null` removes the schema. */
    schemaDefinition: SchemaDefinitionSchema.nullable().optional(),
    /**
     * Replaces the retry overrides as a whole; `null` (or `{}`) clears them
     * so the global defaults apply.
     */
    retryPolicy: RetryPolicyInputSchema.nullable().optional(),
    /** `null` = server default lease. */
    leaseSeconds: LeaseSecondsSchema.nullable().optional(),
    /** Replaces the hand-off targets; `null` or `[]` clears them. */
    nextTubeIds: NextTubeIdsSchema.nullable().optional(),
    /** Moves the tube to another (existing) folder; `null` = top level. */
    folderId: FolderRefSchema.optional(),
  })
  .refine((input) => Object.values(input).some((v) => v !== undefined), {
    message:
      "At least one of name, description, enabled, schemaDefinition, retryPolicy, leaseSeconds, nextTubeIds, folderId is required",
  })
export type UpdateTubeInput = z.input<typeof UpdateTubeInputSchema>

export const ListTubesInputSchema = PageInputSchema.extend({
  /**
   * Only tubes directly inside this folder; `null` (or "null" in a query
   * string) = top-level tubes; omit for all tubes.
   */
  folderId: z.preprocess(
    (v) => (v === "null" ? null : v),
    FolderRefSchema.optional()
  ),
})
export type ListTubesInput = z.input<typeof ListTubesInputSchema>

/**
 * Copies a tube's settings (description, enabled, schema, retry policy).
 * Omitted `name` → "<name> (copy)"; omitted `folderId` → same folder
 * (`null` = top level). `includeItems` also copies every non-deleted item
 * (payload, metadata, tags, priority, idempotency key) as a fresh `pending`
 * item.
 */
export const CloneTubeInputSchema = z.strictObject({
  name: NameSchema.optional(),
  folderId: FolderRefSchema.optional(),
  includeItems: z.boolean().default(false),
})
export type CloneTubeInput = z.input<typeof CloneTubeInputSchema>

export type CloneTubeResult = { tube: Tube; items: number }

/** Drops unset fields; an empty policy becomes `undefined` (= defaults). */
function compactRetryPolicy(
  policy: RetryPolicy | null | undefined
): RetryPolicy | undefined {
  if (!policy) return undefined
  const entries = Object.entries(policy).filter(([, v]) => v !== undefined)
  return entries.length > 0
    ? (Object.fromEntries(entries) as RetryPolicy)
    : undefined
}

export type TubeService = ReturnType<typeof createTubeService>

/**
 * Tube use cases (create / configure / move / delete). Inputs are `unknown`
 * and validated here, so REST, MCP and the dashboard share the same rules.
 */
export function createTubeService(ctx: ServiceContext, actor: Actor) {
  const { storage } = ctx
  const now = () => ctx.clock.now().toISOString()
  const ac = createAccessControl(ctx, actor)

  async function requireTube(repos: Repositories, id: string): Promise<Tube> {
    const tube = await repos.tubes.get(id)
    if (!tube) throw new NotFoundError("Tube", id)
    return tube
  }

  /** Every hand-off target must exist and be in scope (and not be `self`). */
  async function assertNextTubes(
    repos: Repositories,
    ids: string[],
    self?: string
  ) {
    const scope = await ac.view(repos)
    for (const id of ids) {
      if (id === self) {
        throw new ValidationError("A tube cannot hand off to itself", {
          nextTubeIds: ids,
        })
      }
      ac.assertTube(scope, await requireTube(repos, id))
    }
  }

  async function requireFolder(repos: Repositories, id: string | null) {
    if (id === null) return null
    const folder = await repos.folders.get(id)
    if (!folder) throw new NotFoundError("Folder", id)
    return folder
  }

  const service = {
    async list(input: unknown = {}): Promise<PageResult<Tube>> {
      const { offset, limit, folderId } = ListTubesInputSchema.parse(input)
      ac.require("read")
      if (ac.restricted) {
        const scope = await ac.view()
        if (folderId && !scope.canSeeFolder(folderId)) {
          throw new NotFoundError("Folder", folderId)
        }
        const visible = (await storage.tubes.list({ folderId })).filter((t) =>
          scope.canAccessTube(t)
        )
        return {
          data: visible.slice(offset, offset + limit),
          page: { offset, limit, total: visible.length },
        }
      }
      const [data, total] = await Promise.all([
        storage.tubes.list({ folderId, offset, limit }),
        storage.tubes.count({ folderId }),
      ])
      return { data, page: { offset, limit, total } }
    },

    async get(id: string): Promise<Tube> {
      ac.require("read")
      const tube = await requireTube(storage, id)
      ac.assertTube(await ac.view(), tube)
      return tube
    },

    async create(input: unknown): Promise<Tube> {
      const {
        folderId,
        name,
        description,
        enabled,
        schemaDefinition,
        retryPolicy: retryInput,
        leaseSeconds,
        nextTubeIds,
      } = CreateTubeInputSchema.parse(input)
      const retryPolicy = compactRetryPolicy(retryInput)
      if (schemaDefinition) assertValidJsonSchema(schemaDefinition)
      ac.require("structure:manage")
      return transact(ctx, async (repos) => {
        await requireFolder(repos, folderId)
        ac.assertFolderWritable(await ac.view(repos), folderId)
        if (nextTubeIds?.length) await assertNextTubes(repos, nextTubeIds)
        const ts = now()
        const tube = await repos.tubes.create({
          id: ctx.newId(),
          folderId,
          name,
          ...(description !== undefined && { description }),
          enabled,
          ...(schemaDefinition !== undefined && { schemaDefinition }),
          ...(retryPolicy && { retryPolicy }),
          ...(leaseSeconds !== undefined && { leaseSeconds }),
          ...(nextTubeIds?.length && { nextTubeIds }),
          createdAt: ts,
          updatedAt: ts,
        })
        emit(ctx, tubeEvent(actor, "tube.created", tube, ts))
        return tube
      })
    },

    /** Rename / describe / enable / set schema / move (via `folderId`). */
    async update(id: string, input: unknown): Promise<Tube> {
      const {
        name,
        description,
        enabled,
        schemaDefinition,
        retryPolicy,
        leaseSeconds,
        nextTubeIds,
        folderId,
      } = UpdateTubeInputSchema.parse(input)
      if (schemaDefinition) assertValidJsonSchema(schemaDefinition)
      ac.require("structure:manage")
      return transact(ctx, async (repos) => {
        const tube = await requireTube(repos, id)
        const scope = await ac.view(repos)
        ac.assertTube(scope, tube)
        const patch: Patch<Tube> = { updatedAt: now() }
        if (name !== undefined) patch.name = name
        if (description !== undefined) {
          patch.description = description ?? undefined // null clears
        }
        if (enabled !== undefined) patch.enabled = enabled
        if (schemaDefinition !== undefined) {
          patch.schemaDefinition = schemaDefinition ?? undefined // null clears
        }
        if (retryPolicy !== undefined) {
          patch.retryPolicy = compactRetryPolicy(retryPolicy) // null/{} clears
        }
        if (leaseSeconds !== undefined) {
          patch.leaseSeconds = leaseSeconds ?? undefined // null clears
        }
        if (nextTubeIds !== undefined) {
          if (nextTubeIds?.length) await assertNextTubes(repos, nextTubeIds, id)
          patch.nextTubeIds = nextTubeIds?.length ? nextTubeIds : undefined
        }
        if (folderId !== undefined && folderId !== tube.folderId) {
          await requireFolder(repos, folderId)
          ac.assertFolderWritable(scope, folderId)
          patch.folderId = folderId
        }
        const updated = await repos.tubes.update(id, patch)
        if (!updated) throw new NotFoundError("Tube", id)
        emit(ctx, tubeEvent(actor, "tube.updated", updated, updated.updatedAt))
        return updated
      })
    },

    /**
     * New tube with the settings of `id` (see `CloneTubeInputSchema`), plus
     * optionally its items — all in one transaction. Copied items get a
     * `created` history event noting their source item.
     */
    async clone(id: string, input: unknown = {}): Promise<CloneTubeResult> {
      IdSchema.parse(id)
      const { name, folderId, includeItems } = CloneTubeInputSchema.parse(input)
      ac.require("structure:manage")
      if (includeItems) ac.require("items:push")
      return transact(ctx, async (repos) => {
        const source = await requireTube(repos, id)
        const scope = await ac.view(repos)
        ac.assertTube(scope, source)
        const targetFolderId =
          folderId === undefined ? source.folderId : folderId
        await requireFolder(repos, targetFolderId)
        ac.assertFolderWritable(scope, targetFolderId)
        const ts = now()
        const tube = await repos.tubes.create({
          id: ctx.newId(),
          folderId: targetFolderId,
          name: name ?? `${source.name} (copy)`.slice(0, 200),
          ...(source.description !== undefined && {
            description: source.description,
          }),
          enabled: source.enabled,
          ...(source.schemaDefinition !== undefined && {
            schemaDefinition: source.schemaDefinition,
          }),
          ...(source.retryPolicy && { retryPolicy: source.retryPolicy }),
          ...(source.leaseSeconds !== undefined && {
            leaseSeconds: source.leaseSeconds,
          }),
          ...(source.nextTubeIds?.length && {
            nextTubeIds: source.nextTubeIds,
          }),
          createdAt: ts,
          updatedAt: ts,
        })
        emit(ctx, tubeEvent(actor, "tube.created", tube, ts))

        let items = 0
        if (includeItems) {
          for (const original of await repos.items.list({ tubeId: id })) {
            const item = await repos.items.create({
              id: ctx.newId(),
              tubeId: tube.id,
              status: "pending",
              payload: original.payload,
              metadata: original.metadata,
              tags: original.tags,
              priority: original.priority,
              assignedAgent: null,
              leaseExpiresAt: null,
              attempts: 0,
              ...(original.idempotencyKey !== undefined && {
                idempotencyKey: original.idempotencyKey,
              }),
              createdAt: ts,
              updatedAt: ts,
            })
            await recordHistory(ctx, repos, actor, {
              itemId: item.id,
              action: "created",
              oldValue: { clonedFrom: original.id },
              newValue: item,
              at: ts,
            })
            emit(ctx, itemEvent(actor, "created", null, item))
            items++
          }
        }
        return { tube, items }
      })
    },

    /** Moves the tube into another folder, or top level with `null` (shorthand for `update({folderId})`). */
    async move(id: string, folderId: unknown): Promise<Tube> {
      return service.update(id, { folderId })
    },

    /** Deletes a tube that holds no (non-deleted) items. */
    async delete(id: string): Promise<void> {
      ac.require("structure:manage")
      await transact(ctx, async (repos) => {
        const tube = await requireTube(repos, id)
        ac.assertTube(await ac.view(repos), tube)
        const items = await repos.items.count({ tubeId: id })
        if (items > 0) {
          throw new ConflictError(
            `Tube "${id}" is not empty (${items} item(s))`,
            { items }
          )
        }
        // Soft-deleted items are tombstones only; purge them with the tube.
        const tombstones = await repos.items.list({
          tubeId: id,
          includeDeleted: true,
        })
        for (const item of tombstones) await repos.items.delete(item.id)
        await repos.tubes.delete(id)
        emit(ctx, tubeEvent(actor, "tube.deleted", tube, now()))
      })
    },
  }
  return service
}
