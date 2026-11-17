import { z } from "zod"

import type { Actor } from "../domain/actor"
import { ConflictError, NotFoundError } from "../domain/errors"
import { PageInputSchema, type PageResult } from "../domain/pagination"
import {
  FolderSchema,
  IdSchema,
  type Folder,
  type Tube,
} from "../domain/schemas"
import type { Patch, Repositories } from "../storage"

import { createAccessControl } from "./access"
import type { ServiceContext } from "./context"
import { emit, folderEvent, transact } from "./events"

const NameSchema = FolderSchema.shape.name
const DescriptionSchema = z.string().max(2000)

export const CreateFolderInputSchema = z.strictObject({
  name: NameSchema,
  description: DescriptionSchema.optional(),
  /** Omit or `null` for a root folder. */
  parentId: IdSchema.nullable().default(null),
})
export type CreateFolderInput = z.input<typeof CreateFolderInputSchema>

export const UpdateFolderInputSchema = z
  .strictObject({
    name: NameSchema.optional(),
    /** `null` clears the description. */
    description: DescriptionSchema.nullable().optional(),
    /** Moves the folder; `null` moves it to the root. */
    parentId: IdSchema.nullable().optional(),
  })
  .refine((input) => Object.values(input).some((v) => v !== undefined), {
    message: "At least one of name, description, parentId is required",
  })
export type UpdateFolderInput = z.input<typeof UpdateFolderInputSchema>

export const ListFoldersInputSchema = PageInputSchema.extend({
  /** `null` lists root folders; omit for all folders. */
  parentId: IdSchema.nullable().optional(),
})
export type ListFoldersInput = z.input<typeof ListFoldersInputSchema>

/** Folder with its nested subfolders and the tubes it directly contains (leaves). */
export type FolderTreeNode = Folder & {
  children: FolderTreeNode[]
  tubes: Tube[]
}

/** The whole explorer: folder tree plus the top-level tubes (no folder). */
export type Hierarchy = {
  folders: FolderTreeNode[]
  tubes: Tube[]
}

export type FolderService = ReturnType<typeof createFolderService>

/**
 * Folder hierarchy use cases. Inputs are `unknown` and validated here, so
 * REST, MCP and the dashboard share the exact same rules.
 */
export function createFolderService(ctx: ServiceContext, actor: Actor) {
  const { storage } = ctx
  const now = () => ctx.clock.now().toISOString()
  const ac = createAccessControl(ctx, actor)

  async function requireFolder(
    repos: Repositories,
    id: string
  ): Promise<Folder> {
    const folder = await repos.folders.get(id)
    if (!folder) throw new NotFoundError("Folder", id)
    return folder
  }

  const service = {
    async list(input: unknown = {}): Promise<PageResult<Folder>> {
      const { offset, limit, parentId } = ListFoldersInputSchema.parse(input)
      ac.require("read")
      if (ac.restricted) {
        const scope = await ac.view()
        const visible = (await storage.folders.list({ parentId })).filter((f) =>
          scope.canSeeFolder(f.id)
        )
        return {
          data: visible.slice(offset, offset + limit),
          page: { offset, limit, total: visible.length },
        }
      }
      const [data, total] = await Promise.all([
        storage.folders.list({ parentId, offset, limit }),
        storage.folders.count({ parentId }),
      ])
      return { data, page: { offset, limit, total } }
    },

    async get(id: string): Promise<Folder> {
      ac.require("read")
      const folder = await requireFolder(storage, id)
      ac.assertFolderVisible(await ac.view(), folder)
      return folder
    },

    async create(input: unknown): Promise<Folder> {
      const { name, description, parentId } =
        CreateFolderInputSchema.parse(input)
      ac.require("structure:manage")
      return transact(ctx, async (repos) => {
        if (parentId !== null) await requireFolder(repos, parentId)
        ac.assertFolderWritable(await ac.view(repos), parentId)
        const ts = now()
        const folder = await repos.folders.create({
          id: ctx.newId(),
          parentId,
          name,
          ...(description !== undefined && { description }),
          createdAt: ts,
          updatedAt: ts,
        })
        emit(ctx, folderEvent(actor, "folder.created", folder, ts))
        return folder
      })
    },

    /** Rename / describe / move (via `parentId`). */
    async update(id: string, input: unknown): Promise<Folder> {
      const { name, description, parentId } =
        UpdateFolderInputSchema.parse(input)
      ac.require("structure:manage")
      return transact(ctx, async (repos) => {
        const folder = await requireFolder(repos, id)
        const scope = await ac.view(repos)
        ac.assertFolderWritable(scope, id)
        const patch: Patch<Folder> = { updatedAt: now() }
        if (name !== undefined) patch.name = name
        if (description !== undefined) {
          patch.description = description ?? undefined // null clears
        }
        if (parentId !== undefined && parentId !== folder.parentId) {
          if (parentId !== null) {
            await requireFolder(repos, parentId)
            await assertNotDescendant(repos, id, parentId)
          }
          ac.assertFolderWritable(scope, parentId)
          patch.parentId = parentId
        }
        const updated = await repos.folders.update(id, patch)
        if (!updated) throw new NotFoundError("Folder", id)
        emit(
          ctx,
          folderEvent(actor, "folder.updated", updated, updated.updatedAt)
        )
        return updated
      })
    },

    /** Deletes an empty folder (no subfolders, no tubes). */
    async delete(id: string): Promise<void> {
      ac.require("structure:manage")
      await transact(ctx, async (repos) => {
        const folder = await requireFolder(repos, id)
        ac.assertFolderWritable(await ac.view(repos), id)
        const [subfolders, tubes] = await Promise.all([
          repos.folders.count({ parentId: id }),
          repos.tubes.count({ folderId: id }),
        ])
        if (subfolders > 0 || tubes > 0) {
          throw new ConflictError(
            `Folder "${id}" is not empty (${subfolders} subfolder(s), ${tubes} tube(s))`,
            { subfolders, tubes }
          )
        }
        await repos.folders.delete(id)
        emit(ctx, folderEvent(actor, "folder.deleted", folder, now()))
      })
    },

    /**
     * Full nested hierarchy with tubes as leaves, built in memory. Scoped
     * callers get their visible part: accessible subtrees plus the ancestor
     * folders leading to them.
     */
    async tree(): Promise<FolderTreeNode[]> {
      return (await service.hierarchy()).folders
    },

    /** `tree()` plus the visible top-level tubes (those without a folder). */
    async hierarchy(): Promise<Hierarchy> {
      ac.require("read")
      let [folders, tubes] = await Promise.all([
        storage.folders.list(),
        storage.tubes.list(),
      ])
      if (ac.restricted) {
        const scope = await ac.view()
        folders = folders.filter((f) => scope.canSeeFolder(f.id))
        tubes = tubes.filter((t) => scope.canAccessTube(t))
      }
      return {
        folders: buildFolderTree(folders, tubes),
        tubes: tubes.filter((t) => t.folderId === null),
      }
    },
  }
  return service
}

/**
 * Rejects moving `folderId` under `newParentId` when the new parent is the
 * folder itself or one of its descendants (which would create a cycle).
 */
async function assertNotDescendant(
  repos: Repositories,
  folderId: string,
  newParentId: string
): Promise<void> {
  const seen = new Set<string>()
  let current: string | null = newParentId
  while (current !== null && !seen.has(current)) {
    if (current === folderId) {
      throw new ConflictError(
        `Cannot move folder "${folderId}" into itself or one of its descendants`,
        { folderId, parentId: newParentId }
      )
    }
    seen.add(current)
    current = (await repos.folders.get(current))?.parentId ?? null
  }
}

/**
 * Builds the nested tree; folders whose parent is missing become roots.
 * Tubes are attached to their folder (top-level tubes and tubes of unknown
 * folders are not part of it).
 */
export function buildFolderTree(
  folders: Folder[],
  tubes: Tube[] = []
): FolderTreeNode[] {
  const nodes = new Map<string, FolderTreeNode>(
    folders.map((f) => [f.id, { ...f, children: [], tubes: [] }])
  )
  for (const tube of tubes) {
    if (tube.folderId !== null) nodes.get(tube.folderId)?.tubes.push(tube)
  }
  const roots: FolderTreeNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
