import {
  ADMIN_ACCESS,
  roleHasCapability,
  type Access,
  type Capability,
} from "../domain/access"
import type { Actor } from "../domain/actor"
import { ForbiddenError, NotFoundError } from "../domain/errors"
import type { Folder, Item, Tube } from "../domain/schemas"
import type { Repositories } from "../storage"

import type { ServiceContext } from "./context"

/**
 * THE permission check (ticket 16). Every application service asks this
 * module, so REST, MCP (all transports) and the dashboard enforce identical
 * rules:
 *
 * - Capability (role): missing → 403 `forbidden`.
 * - Scope: a scoped key reaches the folders in its scope with their whole
 *   subtree (inherited), plus single tubes. Entities outside the scope are
 *   reported as 404 `not_found` (their existence is not revealed). Ancestor
 *   folders of the scope are *visible* (names, for navigation in lists and
 *   the tree) but not *accessible*: writes there → 403.
 * - Listings return only what the caller can see.
 *
 * Actors without `access` (system components, tests) act as admin.
 */

export const actorAccess = (actor: Actor): Access =>
  actor.access ?? ADMIN_ACCESS

export function actorCan(actor: Actor, capability: Capability): boolean {
  return roleHasCapability(actorAccess(actor).role, capability)
}

const CAPABILITY_LABEL: Record<Capability, string> = {
  read: "read data",
  "items:push": "push items",
  "items:manage": "update or delete items",
  "items:process": "process (claim/complete/fail/release) items",
  "structure:manage": "manage folders and tubes",
  "access:manage": "manage API keys and permissions",
}

/** Throws 403 unless the actor's role grants `capability`. */
export function requireCapability(actor: Actor, capability: Capability): void {
  if (actorCan(actor, capability)) return
  const { role } = actorAccess(actor)
  throw new ForbiddenError(
    `Role "${role}" is not allowed to ${CAPABILITY_LABEL[capability]}`,
    { capability, role }
  )
}

/**
 * What a (possibly scoped) actor can see / touch, computed from the current
 * folder hierarchy. Unrestricted actors get a view that allows everything
 * without loading anything.
 */
export type ScopeView = {
  readonly unrestricted: boolean
  /** Folder in scope (incl. inherited): may be read and changed. */
  canAccessFolder(id: string | null): boolean
  /** Accessible, or an ancestor of something accessible (navigation only). */
  canSeeFolder(id: string): boolean
  canAccessTube(tube: Pick<Tube, "id" | "folderId">): boolean
}

const UNRESTRICTED: ScopeView = {
  unrestricted: true,
  canAccessFolder: () => true,
  canSeeFolder: () => true,
  canAccessTube: () => true,
}

export function buildScopeView(
  access: Access,
  folders: Pick<Folder, "id" | "parentId">[],
  tubes: Pick<Tube, "id" | "folderId">[]
): ScopeView {
  const { scope } = access
  if (!scope || access.role === "admin") return UNRESTRICTED

  const parentOf = new Map(folders.map((f) => [f.id, f.parentId]))
  const childrenOf = new Map<string, string[]>()
  for (const f of folders) {
    if (f.parentId === null) continue
    const list = childrenOf.get(f.parentId) ?? []
    list.push(f.id)
    childrenOf.set(f.parentId, list)
  }

  const accessible = new Set<string>()
  const stack = scope.folderIds.filter((id) => parentOf.has(id))
  while (stack.length > 0) {
    const id = stack.pop()!
    if (accessible.has(id)) continue
    accessible.add(id)
    stack.push(...(childrenOf.get(id) ?? []))
  }

  const scopedTubes = new Set(scope.tubeIds)
  const visible = new Set(accessible)
  const addAncestors = (folderId: string | null) => {
    const seen = new Set<string>()
    let current = folderId
    while (current !== null && current !== undefined && !seen.has(current)) {
      seen.add(current)
      visible.add(current)
      current = parentOf.get(current) ?? null
    }
  }
  for (const id of accessible) addAncestors(parentOf.get(id) ?? null)
  for (const tube of tubes) {
    if (scopedTubes.has(tube.id)) addAncestors(tube.folderId)
  }

  return {
    unrestricted: false,
    canAccessFolder: (id) => id !== null && accessible.has(id),
    canSeeFolder: (id) => visible.has(id),
    canAccessTube: (tube) =>
      scopedTubes.has(tube.id) ||
      (tube.folderId !== null && accessible.has(tube.folderId)),
  }
}

export type AccessControl = ReturnType<typeof createAccessControl>

/** Per-actor access checks used by the services. */
export function createAccessControl(ctx: ServiceContext, actor: Actor) {
  const access = actorAccess(actor)
  const restricted = access.role !== "admin" && access.scope !== null

  async function view(
    repos: Pick<Repositories, "folders" | "tubes"> = ctx.storage
  ): Promise<ScopeView> {
    if (!restricted) return UNRESTRICTED
    const [folders, tubes] = await Promise.all([
      repos.folders.list(),
      repos.tubes.list(),
    ])
    return buildScopeView(access, folders, tubes)
  }

  return {
    access,
    /** True when listings must be filtered (scoped, non-admin actor). */
    restricted,
    can: (capability: Capability) => actorCan(actor, capability),
    require: (capability: Capability) => requireCapability(actor, capability),
    view,

    /** 404 unless the folder is visible (ancestors included). */
    assertFolderVisible(scope: ScopeView, folder: Folder): void {
      if (!scope.canSeeFolder(folder.id)) {
        throw new NotFoundError("Folder", folder.id)
      }
    },

    /**
     * Write access to a folder (or the root, `null`): 404 when invisible,
     * 403 when only visible as an ancestor of the scope.
     */
    assertFolderWritable(scope: ScopeView, folderId: string | null): void {
      if (scope.canAccessFolder(folderId)) return
      if (folderId !== null && !scope.canSeeFolder(folderId)) {
        throw new NotFoundError("Folder", folderId)
      }
      throw new ForbiddenError(
        folderId === null
          ? "Your API key is restricted to part of the folder tree: root folders are out of scope"
          : `Folder "${folderId}" is outside the scope of your API key`,
        { folderId }
      )
    },

    /** 404 unless the tube is in scope. */
    assertTube(scope: ScopeView, tube: Tube): void {
      if (!scope.canAccessTube(tube)) throw new NotFoundError("Tube", tube.id)
    },

    /** 404 unless the item's tube is in scope. */
    assertItem(scope: ScopeView, item: Item, tube: Tube | null): void {
      if (!tube || !scope.canAccessTube(tube)) {
        throw new NotFoundError("Item", item.id)
      }
    },
  }
}
