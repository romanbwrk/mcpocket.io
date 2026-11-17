import { isDeepStrictEqual } from "node:util"

import { z } from "zod"

import { apiKeysFromEnv, generateSecret, hashSecretHex } from "../auth/api-keys"
import {
  AccessScopeSchema,
  isScopeEmpty,
  RoleSchema,
  type AccessScope,
  type Role,
} from "../domain/access"
import { actorToString, type Actor } from "../domain/actor"
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors"
import { PageInputSchema, type PageResult } from "../domain/pagination"
import {
  AgentIdentitySchema,
  ApiKeyIdSchema,
  ApiKeyRecordSchema,
  SecretVisibilitySchema,
  type ApiKeyRecord,
  type SecretVisibility,
  type AuditEvent,
} from "../domain/schemas"
import type { Patch, Repositories } from "../storage"

import { requireCapability } from "./access"
import type { ServiceContext } from "./context"
import { transact } from "./events"

const DescriptionSchema = z.string().trim().max(500)
const RateLimitSchema = ApiKeyRecordSchema.shape.rateLimitPerMinute.unwrap()

export const CreateApiKeyInputSchema = z.strictObject({
  /** Public key id = actor id (`api_key:<id>`), immutable. */
  id: ApiKeyIdSchema,
  description: DescriptionSchema.optional(),
  role: RoleSchema,
  /** `null`/omitted: every folder and tube. Admin keys must be unrestricted. */
  scope: AccessScopeSchema.nullable().default(null),
  /** Requests with this key act as this agent (X-Agent-Id must match if sent). */
  agentId: AgentIdentitySchema.nullable().optional(),
  /** Requests per minute; omitted/null = server default; 0 = unlimited. */
  rateLimitPerMinute: RateLimitSchema.nullable().optional(),
  /** `once` (default): secret shown only now; `always`: viewable later too. */
  secretVisibility: SecretVisibilitySchema.default("once"),
})
export type CreateApiKeyInput = z.input<typeof CreateApiKeyInputSchema>

export const UpdateApiKeyInputSchema = z
  .strictObject({
    /** `null` clears. */
    description: DescriptionSchema.nullable().optional(),
    role: RoleSchema.optional(),
    /** `null`: unrestricted. */
    scope: AccessScopeSchema.nullable().optional(),
    /** `null` unbinds the agent identity. */
    agentId: AgentIdentitySchema.nullable().optional(),
    /** `null`: server default. */
    rateLimitPerMinute: RateLimitSchema.nullable().optional(),
  })
  .refine((input) => Object.values(input).some((v) => v !== undefined), {
    message:
      "At least one of description, role, scope, agentId, rateLimitPerMinute is required",
  })
export type UpdateApiKeyInput = z.input<typeof UpdateApiKeyInputSchema>

export const AuditLogInputSchema = PageInputSchema.extend({
  targetType: z.string().trim().min(1).max(100).optional(),
  targetId: z.string().trim().min(1).max(200).optional(),
})
export type AuditLogInput = z.input<typeof AuditLogInputSchema>

/** A key as returned to admins: never the secret or its hash. */
export type ApiKeyView = {
  id: string
  /** `env` keys come from MCPOCKET_API_KEYS and are read-only. */
  source: "managed" | "env"
  description: string | null
  role: Role
  scope: AccessScope | null
  agentId: string | null
  rateLimitPerMinute: number | null
  secretPrefix: string | null
  /** `always`: the secret can be fetched again with `revealSecret`. */
  secretVisibility: SecretVisibility
  status: "active" | "revoked"
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
  revokedAt: string | null
}

/** Result of create / rotate: the secret is returned exactly once. */
export type ApiKeyWithSecret = { key: ApiKeyView; secret: string }

export function toApiKeyView(record: ApiKeyRecord): ApiKeyView {
  return {
    id: record.id,
    source: "managed",
    description: record.description ?? null,
    role: record.role,
    scope: record.scope,
    agentId: record.agentId ?? null,
    rateLimitPerMinute: record.rateLimitPerMinute ?? null,
    secretPrefix: record.secretPrefix,
    secretVisibility:
      record.secretVisibility === "always" && record.secret ? "always" : "once",
    status: record.revokedAt ? "revoked" : "active",
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revokedAt: record.revokedAt ?? null,
  }
}

/** Audit snapshot of a key: the permission-relevant fields only. */
const auditSnapshot = (key: ApiKeyView) => ({
  role: key.role,
  scope: key.scope,
  agentId: key.agentId,
  rateLimitPerMinute: key.rateLimitPerMinute,
  description: key.description,
  status: key.status,
})

export type ApiKeyService = ReturnType<typeof createApiKeyService>

/**
 * API keys / agent identities and their permissions (ticket 16), admin only
 * (`access:manage`). Every change writes an access audit event in the same
 * transaction.
 */
export function createApiKeyService(ctx: ServiceContext, actor: Actor) {
  const { storage } = ctx
  const now = () => ctx.clock.now().toISOString()
  const admin = () => requireCapability(actor, "access:manage")

  const envViews = (): ApiKeyView[] =>
    apiKeysFromEnv().map((key) => ({
      id: key.id,
      source: "env",
      description: "Configured via MCPOCKET_API_KEYS",
      role: key.role,
      scope: null,
      agentId: null,
      rateLimitPerMinute: null,
      secretPrefix: null,
      secretVisibility: "once",
      status: "active",
      createdBy: null,
      createdAt: null,
      updatedAt: null,
      revokedAt: null,
    }))

  async function audit(
    repos: Repositories,
    event: Omit<AuditEvent, "id" | "actor" | "createdAt" | "targetType"> & {
      at: string
    }
  ) {
    const { at, ...rest } = event
    await repos.audit.append({
      id: ctx.newId(),
      targetType: "api_key",
      actor: actorToString(actor),
      createdAt: at,
      ...rest,
    })
  }

  async function requireManaged(
    repos: Repositories,
    id: string
  ): Promise<ApiKeyRecord> {
    ApiKeyIdSchema.parse(id)
    const record = await repos.apiKeys.get(id)
    if (record) return record
    if (apiKeysFromEnv().some((k) => k.id === id)) {
      throw new ConflictError(
        `API key "${id}" is configured via MCPOCKET_API_KEYS and cannot be changed here`,
        { source: "env" }
      )
    }
    throw new NotFoundError("API key", id)
  }

  /** Role/scope rules + scope ids must exist. */
  async function assertValidPermissions(
    repos: Repositories,
    role: Role,
    scope: AccessScope | null
  ) {
    if (scope === null) return
    if (role === "admin") {
      throw new ValidationError("Admin keys cannot be scoped", [
        { path: "scope", message: "Must be null for the admin role" },
      ])
    }
    if (isScopeEmpty(scope)) {
      throw new ValidationError(
        "A scope needs at least one folder or tube (use null for unrestricted)",
        [{ path: "scope", message: "Empty scope" }]
      )
    }
    const details: { path: string; message: string }[] = []
    for (const [i, id] of scope.folderIds.entries()) {
      if (!(await repos.folders.get(id))) {
        details.push({
          path: `scope.folderIds.${i}`,
          message: "Unknown folder",
        })
      }
    }
    for (const [i, id] of scope.tubeIds.entries()) {
      if (!(await repos.tubes.get(id))) {
        details.push({ path: `scope.tubeIds.${i}`, message: "Unknown tube" })
      }
    }
    if (details.length > 0) {
      throw new ValidationError(
        "Scope references unknown folders or tubes",
        details
      )
    }
  }

  const dedupe = (scope: AccessScope | null): AccessScope | null =>
    scope && {
      folderIds: [...new Set(scope.folderIds)],
      tubeIds: [...new Set(scope.tubeIds)],
    }

  const service = {
    /** Env keys first, then managed keys (oldest first). */
    async list(): Promise<ApiKeyView[]> {
      admin()
      const managed = await storage.apiKeys.list()
      return [...envViews(), ...managed.map(toApiKeyView)]
    },

    async get(id: string): Promise<ApiKeyView> {
      admin()
      ApiKeyIdSchema.parse(id)
      const record = await storage.apiKeys.get(id)
      if (record) return toApiKeyView(record)
      const env = envViews().find((k) => k.id === id)
      if (env) return env
      throw new NotFoundError("API key", id)
    },

    /** Creates a key; the returned `secret` is never retrievable again. */
    async create(input: unknown): Promise<ApiKeyWithSecret> {
      admin()
      const parsed = CreateApiKeyInputSchema.parse(input)
      const scope = dedupe(parsed.scope)
      if (apiKeysFromEnv().some((k) => k.id === parsed.id)) {
        throw new ConflictError(
          `API key id "${parsed.id}" is already used by MCPOCKET_API_KEYS`,
          { id: parsed.id }
        )
      }
      const { secret, prefix } = generateSecret()
      return transact(ctx, async (repos) => {
        if (await repos.apiKeys.get(parsed.id)) {
          throw new ConflictError(`API key "${parsed.id}" already exists`, {
            id: parsed.id,
          })
        }
        await assertValidPermissions(repos, parsed.role, scope)
        const ts = now()
        const record = await repos.apiKeys.create({
          id: parsed.id,
          ...(parsed.description && { description: parsed.description }),
          role: parsed.role,
          scope,
          agentId: parsed.agentId ?? null,
          rateLimitPerMinute: parsed.rateLimitPerMinute ?? null,
          secretHash: hashSecretHex(secret),
          secretPrefix: prefix,
          secretVisibility: parsed.secretVisibility,
          ...(parsed.secretVisibility === "always" && { secret }),
          createdBy: actorToString(actor),
          revokedAt: null,
          createdAt: ts,
          updatedAt: ts,
        })
        const key = toApiKeyView(record)
        await audit(repos, {
          action: "api_key.created",
          targetId: key.id,
          newValue: auditSnapshot(key),
          at: ts,
        })
        return { key, secret }
      })
    },

    /** Changes role / scope / agent binding / rate limit / description. */
    async update(id: string, input: unknown): Promise<ApiKeyView> {
      admin()
      const parsed = UpdateApiKeyInputSchema.parse(input)
      return transact(ctx, async (repos) => {
        const record = await requireManaged(repos, id)
        const role = parsed.role ?? record.role
        const scope =
          parsed.scope !== undefined ? dedupe(parsed.scope) : record.scope
        await assertValidPermissions(repos, role, scope)
        const patch: Patch<ApiKeyRecord> = { role, scope }
        if (parsed.description !== undefined) {
          patch.description = parsed.description || undefined
        }
        if (parsed.agentId !== undefined) patch.agentId = parsed.agentId
        if (parsed.rateLimitPerMinute !== undefined) {
          patch.rateLimitPerMinute = parsed.rateLimitPerMinute
        }
        const before = toApiKeyView(record)
        const candidate = toApiKeyView({ ...record, ...patch } as ApiKeyRecord)
        if (
          isDeepStrictEqual(auditSnapshot(before), auditSnapshot(candidate))
        ) {
          return before // no-op
        }
        const ts = now()
        const updated = await repos.apiKeys.update(id, {
          ...patch,
          updatedAt: ts,
        })
        if (!updated) throw new NotFoundError("API key", id)
        const key = toApiKeyView(updated)
        await audit(repos, {
          action: "api_key.updated",
          targetId: id,
          oldValue: auditSnapshot(before),
          newValue: auditSnapshot(key),
          at: ts,
        })
        return key
      })
    },

    /** New secret (old one stops working immediately); returned once. Also re-activates a revoked key. */
    async rotate(id: string): Promise<ApiKeyWithSecret> {
      admin()
      const { secret, prefix } = generateSecret()
      return transact(ctx, async (repos) => {
        const record = await requireManaged(repos, id)
        const ts = now()
        const updated = await repos.apiKeys.update(id, {
          secretHash: hashSecretHex(secret),
          secretPrefix: prefix,
          // Viewable keys keep showing their (new) secret.
          ...(record.secretVisibility === "always" && { secret }),
          revokedAt: null,
          updatedAt: ts,
        })
        if (!updated) throw new NotFoundError("API key", id)
        const key = toApiKeyView(updated)
        await audit(repos, {
          action: "api_key.secret_rotated",
          targetId: id,
          oldValue: {
            secretPrefix: record.secretPrefix,
            status: toApiKeyView(record).status,
          },
          newValue: { secretPrefix: prefix, status: key.status },
          at: ts,
        })
        return { key, secret }
      })
    },

    /**
     * The clear-text secret of a key created with `secretVisibility:
     * "always"` (409 for show-once and env keys).
     */
    async revealSecret(id: string): Promise<string> {
      admin()
      const record = await requireManaged(storage, id)
      if (record.secretVisibility !== "always" || !record.secret) {
        throw new ConflictError(
          `The secret of API key "${id}" was shown once and is not stored`,
          { secretVisibility: "once" }
        )
      }
      return record.secret
    },

    /** Disables the key (kept for attribution; rotate re-activates it). */
    async revoke(id: string): Promise<ApiKeyView> {
      admin()
      return transact(ctx, async (repos) => {
        const record = await requireManaged(repos, id)
        if (record.revokedAt) return toApiKeyView(record)
        const ts = now()
        const updated = await repos.apiKeys.update(id, {
          revokedAt: ts,
          updatedAt: ts,
        })
        if (!updated) throw new NotFoundError("API key", id)
        await audit(repos, {
          action: "api_key.revoked",
          targetId: id,
          oldValue: { status: "active" },
          newValue: { status: "revoked", revokedAt: ts },
          at: ts,
        })
        return toApiKeyView(updated)
      })
    },

    /** Removes the key for good (its audit trail stays). */
    async delete(id: string): Promise<void> {
      admin()
      await transact(ctx, async (repos) => {
        const record = await requireManaged(repos, id)
        await repos.apiKeys.delete(id)
        await audit(repos, {
          action: "api_key.deleted",
          targetId: id,
          oldValue: auditSnapshot(toApiKeyView(record)),
          at: now(),
        })
      })
    },

    /** Access audit log (key and permission changes), newest first. */
    async auditLog(input: unknown = {}): Promise<PageResult<AuditEvent>> {
      admin()
      const { offset, limit, targetType, targetId } =
        AuditLogInputSchema.parse(input)
      const query = { targetType, targetId }
      const [data, total] = await Promise.all([
        storage.audit.list({ ...query, offset, limit }),
        storage.audit.count(query),
      ])
      return { data, page: { offset, limit, total } }
    },
  }
  return service
}
