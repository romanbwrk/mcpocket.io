import { z } from "zod"

import { ADMIN_ACCESS, type Access } from "../domain/access"
import type { Actor } from "../domain/actor"
import { ForbiddenError, ValidationError } from "../domain/errors"
import { IdSchema } from "../domain/schemas"
import { actorAccess, buildScopeView, getServices } from "../services"

import { MCP_INSTRUCTIONS } from "./server"
import { mcpTools, type McpToolDefinition } from "./tools"

/**
 * Scoped MCP connections: the same server, but the session only ever sees
 * one tube or one folder subtree, whatever the API key could reach otherwise.
 *
 * | target | HTTP                           | legacy SSE            | stdio env           |
 * |--------|--------------------------------|-----------------------|---------------------|
 * | tube   | `/api/mcp/tubes/{tubeId}`      | `/api/mcp/sse?tubeId=`   | `MCPOCKET_TUBE_ID`   |
 * | folder | `/api/mcp/folders/{folderId}`  | `/api/mcp/sse?folderId=` | `MCPOCKET_FOLDER_ID` |
 *
 * - The actor's scope is replaced by the target. Admin keys bypass scopes,
 *   so they act as `operator` here (admin only adds `access:manage`, which
 *   no MCP tool uses). Other roles keep their capabilities.
 * - The target must be fully accessible with the key's own permissions, so
 *   binding can only ever narrow access (404 when invisible, 403 when the
 *   folder is only visible as an ancestor of the key's scope).
 * - Tube: `tubeId` arguments default to the tube; folder and tube
 *   structure tools are not offered.
 * - Folder: `create_folder.parentId` / `create_tube.folderId` default to the
 *   folder; the bound folder itself cannot be deleted or moved.
 */
export type ScopeTarget = { kind: "tube" | "folder"; id: string }

/** Tools hidden on tube-scoped connections (they work on the tree, not a tube). */
export const TUBE_SCOPED_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "list_folders",
  "create_folder",
  "update_folder",
  "move_folder",
  "delete_folder",
  "get_folder_tree",
  "create_tube",
  "move_tube",
  "delete_tube",
])

/** Folder-scoped connections: argument that defaults to the bound folder. */
export const FOLDER_SCOPED_DEFAULT_ARGS: Readonly<Record<string, string>> = {
  create_folder: "parentId",
  create_tube: "folderId",
}

/** Folder-scoped connections: tools that must not delete/move the bound folder. */
export const FOLDER_SCOPED_PROTECTED_TOOLS: ReadonlySet<string> = new Set([
  "delete_folder",
  "move_folder",
  "update_folder",
])

/** `access` narrowed to the target (the key's role, admin → operator). */
export function narrowAccess(
  access: Access | undefined,
  target: ScopeTarget
): Access {
  const role = !access || access.role === "admin" ? "operator" : access.role
  if (target.kind === "folder") {
    return { role, scope: { folderIds: [target.id], tubeIds: [] } }
  }
  const own = access ?? ADMIN_ACCESS
  return {
    role,
    scope: { folderIds: [], tubeIds: [target.id] },
    // Pipeline hand-offs: the key's own reach (never wider than the key).
    handoffAccess: { role: own.role, scope: own.scope },
  }
}

export const narrowActor = (actor: Actor, target: ScopeTarget): Actor => ({
  ...actor,
  access: narrowAccess(actor.access, target),
})

/** A pipeline stage this connection may hand off to (tube-scoped only). */
export type HandoffTube = { id: string; name: string }

const objectInput = (tool: McpToolDefinition) =>
  tool.input instanceof z.ZodObject ? tool.input : null

/** Makes `arg` optional (advertised) and fills it with `value` when omitted. */
function withDefaultArg(
  tool: McpToolDefinition,
  arg: string,
  value: string,
  note: string
): McpToolDefinition {
  const input = objectInput(tool)
  if (!input || !(arg in input.shape)) return tool
  return {
    ...tool,
    description: `${tool.description} ${note}`,
    input: input.extend({ [arg]: (input.shape[arg] as z.ZodType).optional() }),
    run: (services, args) =>
      tool.run(
        services,
        args[arg] === undefined ? { ...args, [arg]: value } : args
      ),
  }
}

function protectFolder(
  tool: McpToolDefinition,
  folderId: string
): McpToolDefinition {
  return {
    ...tool,
    run: (services, args) => {
      const moves = tool.name !== "update_folder" || "parentId" in args
      if (args.id === folderId && moves) {
        throw new ForbiddenError(
          "This connection is bound to this folder: it cannot be deleted or moved here",
          { folderId }
        )
      }
      return tool.run(services, args)
    },
  }
}

/** The tool set of a connection bound to `target`. */
export function scopedTools(
  target: ScopeTarget,
  tools: McpToolDefinition[] = mcpTools
): McpToolDefinition[] {
  if (target.kind === "tube") {
    return tools
      .filter((tool) => !TUBE_SCOPED_HIDDEN_TOOLS.has(tool.name))
      .map((tool) =>
        withDefaultArg(
          tool,
          "tubeId",
          target.id,
          "tubeId defaults to this connection's tube."
        )
      )
  }
  return tools.map((tool) => {
    const arg = FOLDER_SCOPED_DEFAULT_ARGS[tool.name]
    if (arg) {
      return withDefaultArg(
        tool,
        arg,
        target.id,
        `${arg} defaults to this connection's folder.`
      )
    }
    if (FOLDER_SCOPED_PROTECTED_TOOLS.has(tool.name)) {
      return protectFolder(tool, target.id)
    }
    return tool
  })
}

export function scopedInstructions(
  target: ScopeTarget,
  name: string,
  handoff: HandoffTube[] = []
) {
  const next =
    handoff.length > 0
      ? " Pipeline: hand your output to the next stage with complete_item next: [{ tubeId, payload }] into " +
        handoff.map((t) => `"${t.name}" (tubeId ${t.id})`).join(" or ") +
        " — you can push there through complete_item only; those tubes are otherwise invisible."
      : ""
  const current =
    " The current hand-off targets are this tube's nextTubeIds (mcpocket://tubes/" +
    target.id +
    "); they are checked on every complete_item."
  const intro =
    target.kind === "tube"
      ? `This connection is bound to the tube "${name}" (id ${target.id}): ` +
        "it is the only tube you can see, and every tubeId argument defaults to it, so you can omit it. " +
        "Folder and tube structure tools are not available here." +
        next +
        current
      : `This connection is bound to the folder "${name}" (id ${target.id}) and everything below it: ` +
        "other folders and tubes are invisible (ancestor folders appear by name only). " +
        "create_folder and create_tube place new entries in this folder unless you pass parentId / folderId; " +
        "the bound folder itself cannot be deleted or moved."
  return `${intro}\n\n${MCP_INSTRUCTIONS}`
}

/**
 * Resolves a scoped connection for an authenticated actor. The target must
 * be fully accessible with the key's own permissions.
 */
export async function resolveConnectionScope(
  actor: Actor,
  target: ScopeTarget
) {
  const id = IdSchema.parse(target.id)
  const services = await getServices(actor)
  let name: string
  let handoff: HandoffTube[] = []
  if (target.kind === "tube") {
    const tube = await services.tubes.get(id) // 404 unless in scope
    name = tube.name
    if (tube.nextTubeIds?.length) {
      // Named in the instructions: targets the key itself can reach.
      const { storage } = services.ctx
      const [folders, tubes] = await Promise.all([
        storage.folders.list(),
        storage.tubes.list(),
      ])
      const view = buildScopeView(actorAccess(actor), folders, tubes)
      const byId = new Map(tubes.map((t) => [t.id, t]))
      handoff = tube.nextTubeIds
        .map((tid) => byId.get(tid))
        .filter((t) => t !== undefined && view.canAccessTube(t))
        .map((t) => ({ id: t!.id, name: t!.name }))
    }
  } else {
    const folder = await services.folders.get(id) // 404 unless visible
    const { storage } = services.ctx
    const [folders, tubes] = await Promise.all([
      storage.folders.list(),
      storage.tubes.list(),
    ])
    const view = buildScopeView(actorAccess(actor), folders, tubes)
    if (!view.canAccessFolder(folder.id)) {
      throw new ForbiddenError(
        `Folder "${folder.id}" is outside the scope of your API key`,
        { folderId: folder.id }
      )
    }
    name = folder.name
  }
  const bound = { kind: target.kind, id }
  return {
    target: bound,
    name,
    actor: narrowActor(actor, bound),
    tools: scopedTools(bound),
    instructions: scopedInstructions(bound, name, handoff),
  }
}

/** `?tubeId=` / `?folderId=` of a URL (legacy SSE), at most one. */
export function scopeTargetFromSearch(
  params: URLSearchParams
): ScopeTarget | undefined {
  const tubeId = params.get("tubeId")
  const folderId = params.get("folderId")
  if (tubeId !== null && folderId !== null) {
    throw new ValidationError("Pass either tubeId or folderId, not both")
  }
  if (tubeId !== null) return { kind: "tube", id: tubeId }
  if (folderId !== null) return { kind: "folder", id: folderId }
  return undefined
}
