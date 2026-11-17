import type { AccessScope, Role } from "@mcpocket/core/domain/access"
import type { SecretVisibility } from "@mcpocket/core/domain/schemas"

import {
  flattenFolders,
  type ExplorerFolder,
  type ExplorerTube,
} from "./explorer"

/**
 * Client-safe helpers for the API keys page (ticket 16): scope picker
 * options, scope summaries and form → service input conversion. The service
 * validates everything again.
 */

export type ScopeOption = {
  kind: "folder" | "tube"
  id: string
  name: string
  depth: number
  /** "Sales / Inbound" (tube: folder path + tube name) */
  path: string
}

/**
 * Folders depth-first, each followed by its tubes (one level deeper), then
 * the top-level tubes (no folder).
 */
export function scopeOptions(
  tree: ExplorerFolder[],
  rootTubes: ExplorerTube[] = []
): ScopeOption[] {
  return [
    ...folderScopeOptions(tree, 0, ""),
    ...rootTubes.map((tube) => ({
      kind: "tube" as const,
      id: tube.id,
      name: tube.name,
      depth: 0,
      path: tube.name,
    })),
  ]
}

function folderScopeOptions(
  tree: ExplorerFolder[],
  depth: number,
  prefix: string
): ScopeOption[] {
  return tree.flatMap((folder) => {
    const path = prefix ? `${prefix} / ${folder.name}` : folder.name
    return [
      {
        kind: "folder" as const,
        id: folder.id,
        name: folder.name,
        depth,
        path,
      },
      ...folderScopeOptions(folder.children, depth + 1, path),
      ...folder.tubes.map((tube) => ({
        kind: "tube" as const,
        id: tube.id,
        name: tube.name,
        depth: depth + 1,
        path: `${path} / ${tube.name}`,
      })),
    ]
  })
}

/** Human summary: "All folders & tubes" or the scoped paths (unknown ids flagged). */
export function scopeSummary(
  scope: AccessScope | null,
  tree: ExplorerFolder[],
  rootTubes: ExplorerTube[] = []
): { label: string; paths: string[] } {
  if (!scope) return { label: "All folders & tubes", paths: [] }
  const folders = new Map(flattenFolders(tree).map((f) => [f.id, f.path]))
  const tubes = new Map(
    scopeOptions(tree, rootTubes)
      .filter((o) => o.kind === "tube")
      .map((o) => [o.id, o.path])
  )
  const paths = [
    ...scope.folderIds.map(
      (id) => `${folders.get(id) ?? "(deleted folder)"} /**`
    ),
    ...scope.tubeIds.map((id) => tubes.get(id) ?? "(deleted tube)"),
  ]
  const parts = [
    scope.folderIds.length > 0 &&
      `${scope.folderIds.length} folder${scope.folderIds.length === 1 ? "" : "s"}`,
    scope.tubeIds.length > 0 &&
      `${scope.tubeIds.length} tube${scope.tubeIds.length === 1 ? "" : "s"}`,
  ].filter(Boolean)
  return { label: parts.join(", ") || "Nothing", paths }
}

export type KeyFormFields = {
  id?: string
  description: string
  role: Role
  /** "all" or "selected" */
  scopeMode: "all" | "selected"
  folderIds: string[]
  tubeIds: string[]
  agentId: string
  /** "" = server default */
  rateLimit: string
  /** Create only: show the secret once, or keep it viewable. */
  secretVisibility: SecretVisibility
}

/**
 * Form fields → service input. `editing` sends `null` for cleared optional
 * values (so they are removed) instead of omitting them.
 */
export function keyFormInput(
  fields: KeyFormFields,
  editing: boolean
): Record<string, unknown> {
  const description = fields.description.trim()
  const agentId = fields.agentId.trim()
  const rate = fields.rateLimit.trim()
  const scope =
    fields.role === "admin" || fields.scopeMode === "all"
      ? null
      : { folderIds: fields.folderIds, tubeIds: fields.tubeIds }
  const clear = editing ? null : undefined
  const input: Record<string, unknown> = {
    ...(!editing && {
      id: fields.id?.trim() ?? "",
      secretVisibility: fields.secretVisibility,
    }),
    role: fields.role,
    scope,
    description: description || clear,
    agentId: agentId || clear,
    rateLimitPerMinute: rate === "" ? clear : Number(rate),
  }
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined)
  )
}
