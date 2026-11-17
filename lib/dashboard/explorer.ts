import type { ErrorInfo } from "@mcpocket/core/services/errors"
import type { Tube } from "@mcpocket/core/domain/schemas"
import type { FolderTreeNode } from "@mcpocket/core/services/folders"

/**
 * Client-safe DTOs and helpers for the dashboard folder explorer. Shared by
 * server components (which build the DTOs) and client components.
 */

export type ExplorerTube = {
  id: string
  /** `null` = top-level tube. */
  folderId: string | null
  name: string
  description?: string
  enabled: boolean
}

export type ExplorerFolder = {
  id: string
  parentId: string | null
  name: string
  description?: string
  children: ExplorerFolder[]
  tubes: ExplorerTube[]
}

/** Result of every dashboard server action: data or a normalized service error. */
export type ActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; error: ErrorInfo }

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" })

/** Strips the service tree to what the browser needs, sorted by name. */
export function toExplorerTree(nodes: FolderTreeNode[]): ExplorerFolder[] {
  return nodes
    .map((node) => ({
      id: node.id,
      parentId: node.parentId,
      name: node.name,
      ...(node.description !== undefined && { description: node.description }),
      children: toExplorerTree(node.children),
      tubes: toExplorerTubes(node.tubes),
    }))
    .sort(byName)
}

/** Tube DTOs for the explorer, sorted by name. */
export function toExplorerTubes(tubes: Tube[]): ExplorerTube[] {
  return tubes
    .map((t) => ({
      id: t.id,
      folderId: t.folderId,
      name: t.name,
      ...(t.description !== undefined && { description: t.description }),
      enabled: t.enabled,
    }))
    .sort(byName)
}

export type FolderOption = {
  id: string
  name: string
  depth: number
  /** "Sales / Inbound / Leads" */
  path: string
}

/** Depth-first list of all folders (for move/parent pickers). */
export function flattenFolders(
  tree: ExplorerFolder[],
  depth = 0,
  prefix = ""
): FolderOption[] {
  return tree.flatMap((folder) => {
    const path = prefix ? `${prefix} / ${folder.name}` : folder.name
    return [
      { id: folder.id, name: folder.name, depth, path },
      ...flattenFolders(folder.children, depth + 1, path),
    ]
  })
}

/** Folder ids from the root down to (and including) the folder containing `tubeId`. */
export function tubeAncestorIds(
  tree: ExplorerFolder[],
  tubeId: string
): string[] | null {
  for (const folder of tree) {
    if (folder.tubes.some((t) => t.id === tubeId)) return [folder.id]
    const below = tubeAncestorIds(folder.children, tubeId)
    if (below) return [folder.id, ...below]
  }
  return null
}

/** Folder ids from the root down to the parent of `folderId` (excluding itself). */
export function folderAncestorIds(
  tree: ExplorerFolder[],
  folderId: string
): string[] | null {
  for (const folder of tree) {
    if (folder.id === folderId) return []
    const below = folderAncestorIds(folder.children, folderId)
    if (below) return [folder.id, ...below]
  }
  return null
}

export function findFolder(
  tree: ExplorerFolder[],
  id: string
): ExplorerFolder | null {
  for (const folder of tree) {
    if (folder.id === id) return folder
    const found = findFolder(folder.children, id)
    if (found) return found
  }
  return null
}
