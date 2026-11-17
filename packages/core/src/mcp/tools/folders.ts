import { z } from "zod"

import { IdSchema } from "../../domain/schemas"
import {
  CreateFolderInputSchema,
  ListFoldersInputSchema,
  UpdateFolderInputSchema,
} from "../../services"

import { defineTool, IdArgSchema, splitId } from "./define"

const MoveFolderArgsSchema = z.object({ parentId: IdSchema.nullable() })

/** Folder tools (plan §5.1). Results mirror the REST response bodies. */
export const folderTools = [
  defineTool({
    name: "list_folders",
    capability: "read",
    title: "List folders",
    description:
      "List folders (paginated, oldest first). Pass parentId to list the direct subfolders of a folder, parentId: null for root folders, or omit it for all folders. Returns { data: Folder[], page: { offset, limit, total } }.",
    input: ListFoldersInputSchema,
    annotations: { readOnlyHint: true },
    run: (services, args) => services.folders.list(args),
  }),
  defineTool({
    name: "create_folder",
    capability: "structure:manage",
    title: "Create folder",
    description:
      "Create a folder. Omit parentId (or pass null) for a root folder. Returns { data: Folder }.",
    input: CreateFolderInputSchema,
    run: async (services, args) => ({
      data: await services.folders.create(args),
    }),
  }),
  defineTool({
    name: "update_folder",
    capability: "structure:manage",
    title: "Update folder",
    description:
      "Update a folder's name and/or description (description: null clears it). parentId moves it, like move_folder. Returns { data: Folder }.",
    input: IdArgSchema.extend(UpdateFolderInputSchema.shape),
    annotations: { idempotentHint: true },
    run: async (services, args) => {
      const { id, rest } = splitId(args)
      return { data: await services.folders.update(id, rest) }
    },
  }),
  defineTool({
    name: "move_folder",
    capability: "structure:manage",
    title: "Move folder",
    description:
      "Move a folder under another folder (parentId) or to the root (parentId: null). Moving a folder into itself or a descendant is rejected. Returns { data: Folder }.",
    input: IdArgSchema.extend(MoveFolderArgsSchema.shape),
    annotations: { idempotentHint: true },
    run: async (services, args) => {
      const { id, rest } = splitId(args)
      const { parentId } = MoveFolderArgsSchema.parse(rest)
      return { data: await services.folders.update(id, { parentId }) }
    },
  }),
  defineTool({
    name: "delete_folder",
    capability: "structure:manage",
    title: "Delete folder",
    description:
      "Delete an empty folder. Fails with a conflict if it still contains subfolders or tubes. Returns { deleted: true, id }.",
    input: IdArgSchema,
    annotations: { destructiveHint: true, idempotentHint: false },
    run: async (services, args) => {
      const { id } = splitId(args)
      await services.folders.delete(id)
      return { deleted: true, id }
    },
  }),
  defineTool({
    name: "get_folder_tree",
    capability: "read",
    title: "Get folder tree",
    description:
      "Retrieve the complete folder hierarchy: root folders with nested `children` and the `tubes` each folder directly contains, plus `rootTubes` (tubes without a folder). Returns { data: FolderTreeNode[], rootTubes: Tube[] }.",
    input: z.object({}),
    annotations: { readOnlyHint: true },
    run: async (services) => {
      const { folders, tubes } = await services.folders.hierarchy()
      return { data: folders, rootTubes: tubes }
    },
  }),
]
