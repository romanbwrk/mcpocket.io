import { z } from "zod"

/**
 * Role-based access control model (plan §10), client-safe.
 *
 * A role grants capabilities; an optional scope restricts a non-admin key to
 * folder subtrees and/or single tubes. Enforcement lives in the application
 * services (`lib/services/access.ts`), so REST, MCP and the dashboard share
 * the exact same rules.
 */

export const ROLES = ["admin", "operator", "agent", "readonly"] as const
export const RoleSchema = z.enum(ROLES)
export type Role = z.infer<typeof RoleSchema>

export const CAPABILITIES = [
  /** Read folders, tubes, items, history, statistics. */
  "read",
  /** Push items (single and bulk). */
  "items:push",
  /** Update, delete, reassign items (single and bulk). */
  "items:manage",
  /** Claim, heartbeat, complete, fail, release items (agent work loop). */
  "items:process",
  /** Create, update, move, delete folders and tubes. */
  "structure:manage",
  /** Manage API keys, roles and permissions; read the access audit log. */
  "access:manage",
] as const
export type Capability = (typeof CAPABILITIES)[number]

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  admin: CAPABILITIES,
  operator: [
    "read",
    "items:push",
    "items:manage",
    "items:process",
    "structure:manage",
  ],
  agent: ["read", "items:push", "items:process"],
  readonly: ["read"],
}

export const ROLE_META: Record<Role, { label: string; description: string }> = {
  admin: {
    label: "Admin",
    description:
      "Everything, everywhere: data, structure, API keys and permissions.",
  },
  operator: {
    label: "Operator",
    description:
      "Manage folders, tubes and items and process items within its scope.",
  },
  agent: {
    label: "Agent",
    description:
      "Read, push items and run the claim → complete work loop within its scope.",
  },
  readonly: {
    label: "Read-only",
    description: "Read folders, tubes, items, history and statistics.",
  },
}

export const roleHasCapability = (role: Role, capability: Capability) =>
  ROLE_CAPABILITIES[role].includes(capability)

/**
 * Restricts access to the listed folders (with everything below them,
 * inherited down the tree) and tubes. `null` = unrestricted.
 */
export const AccessScopeSchema = z.strictObject({
  folderIds: z.array(z.uuid()).max(500).default([]),
  tubeIds: z.array(z.uuid()).max(500).default([]),
})
export type AccessScope = z.infer<typeof AccessScopeSchema>

/** Effective permissions of an authenticated principal. */
export type Access = {
  role: Role
  /** `null`: every folder and tube. */
  scope: AccessScope | null
  /**
   * The API key's own (un-narrowed) access, kept by tube-scoped MCP
   * connections: a pipeline hand-off (`complete` `next` from a tube into
   * one of its `nextTubeIds`) may target any tube this access reaches,
   * although `scope` hides it. Checked against current settings per call.
   */
  handoffAccess?: Pick<Access, "role" | "scope">
}

export const ADMIN_ACCESS: Access = { role: "admin", scope: null }

export const isScopeEmpty = (scope: AccessScope) =>
  scope.folderIds.length === 0 && scope.tubeIds.length === 0
