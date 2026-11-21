import { z } from "zod"

import { IdSchema } from "../../domain/schemas"
import {
  CreateTubeInputSchema,
  ListTubesInputSchema,
  TubeMemoryInputSchema,
  UpdateTubeInputSchema,
} from "../../services"

import { defineTool, IdArgSchema, splitId } from "./define"

const TubeIdArgSchema = z.object({ tubeId: IdSchema })
const MemoryIdArgSchema = TubeIdArgSchema.extend({ memoryId: IdSchema })

/** `{ tubeId, memoryId?, ...rest }`, ids validated like REST path ids. */
function splitTubeArgs(args: Record<string, unknown>) {
  const { tubeId, memoryId, ...rest } = args
  return {
    tubeId: IdSchema.parse(tubeId),
    memoryId: memoryId === undefined ? undefined : IdSchema.parse(memoryId),
    rest,
  }
}

const MoveTubeArgsSchema = z.object({
  /** Target folder; `null` moves the tube to the top level. */
  folderId: IdSchema.nullable(),
})

/** Tube tools (plan §5.2; `get_tube_statistics` lives in ./statistics). */
export const tubeTools = [
  defineTool({
    name: "list_tubes",
    capability: "read",
    title: "List tubes",
    description:
      "List tubes (paginated, oldest first), optionally only those directly inside folderId (null = top-level tubes without a folder) and/or named exactly name. withCounts: true adds counts: { pending, processing, completed, failed, retry, cancelled, archived } (non-deleted items) to each tube. Returns { data: Tube[], page: { offset, limit, total } }.",
    input: ListTubesInputSchema,
    annotations: { readOnlyHint: true },
    run: (services, args) => services.tubes.list(args),
  }),
  defineTool({
    name: "create_tube",
    capability: "structure:manage",
    title: "Create tube",
    description:
      "Create a tube (a queue/collection of JSON items), optionally inside a folder (omit folderId or pass null for a top-level tube). Optional schemaDefinition is a JSON Schema every item payload must satisfy. Optional retryPolicy { maxAttempts, backoff: fixed|exponential, delaySeconds, maxDelaySeconds } overrides the server retry defaults per field. Optional leaseSeconds (0..86400) is the default lease for claims in this tube — set it above the job time for slow work such as video generation; 0 = leases never expire (items stay processing until complete / fail / release or a manual status change). Optional nextTubeIds (≤ 20 existing tubes) declares the pipeline stages this tube hands off to: agents connected to just this tube may then complete_item with next into them. Optional instructions (≤ 50000 chars, Markdown) tell agents how to work this tube, like a skill. Returns { data: Tube }.",
    input: CreateTubeInputSchema,
    run: async (services, args) => ({
      data: await services.tubes.create(args),
    }),
  }),
  defineTool({
    name: "update_tube",
    capability: "structure:manage",
    title: "Update tube",
    description:
      "Update tube settings: name, description (null clears), enabled, schemaDefinition (null removes the schema), retryPolicy (replaces the overrides; null or {} = server defaults), leaseSeconds (default claim lease; 0 = never expires; null = server default), nextTubeIds (pipeline hand-off targets, replaced as a whole; null or [] clears), instructions (how agents should work this tube; replaced as a whole; null or an empty string clears); folderId moves it like move_tube (null = top level). Returns { data: Tube }.",
    input: IdArgSchema.extend(UpdateTubeInputSchema.shape),
    annotations: { idempotentHint: true },
    run: async (services, args) => {
      const { id, rest } = splitId(args)
      return { data: await services.tubes.update(id, rest) }
    },
  }),
  defineTool({
    name: "get_tube_context",
    capability: "read",
    title: "Get tube instructions and memory",
    description:
      "Read a tube's instructions (how to work it, like a skill — follow them) and its memory (notes kept by agents and users, oldest first). Call it before working a tube. Returns { data: { tubeId, name, instructions: string | null, memory: [{ id, text, createdAt, updatedAt }] } }.",
    input: TubeIdArgSchema,
    annotations: { readOnlyHint: true },
    run: async (services, args) => ({
      data: await services.tubes.context(splitTubeArgs(args).tubeId),
    }),
  }),
  defineTool({
    name: "add_tube_memory",
    capability: "items:process",
    title: "Add tube memory",
    description:
      "Append a memory block (text ≤ 10000 chars, ≤ 200 blocks per tube) to a tube: a durable note for whoever works this tube next — lessons learned, conventions, pitfalls, decisions. Keep blocks short and self-contained; prefer update_tube_memory over adding near-duplicates. Returns { data: { id, text, createdAt, updatedAt } }.",
    input: TubeIdArgSchema.extend(TubeMemoryInputSchema.shape),
    run: async (services, args) => {
      const { tubeId, rest } = splitTubeArgs(args)
      return { data: await services.tubes.addMemory(tubeId, rest) }
    },
  }),
  defineTool({
    name: "update_tube_memory",
    capability: "items:process",
    title: "Update tube memory",
    description:
      "Replace the text of one memory block of a tube (memoryId from get_tube_context). Returns { data: { id, text, createdAt, updatedAt } }.",
    input: MemoryIdArgSchema.extend(TubeMemoryInputSchema.shape),
    annotations: { idempotentHint: true },
    run: async (services, args) => {
      const { tubeId, memoryId, rest } = splitTubeArgs(args)
      return {
        data: await services.tubes.updateMemory(tubeId, memoryId!, rest),
      }
    },
  }),
  defineTool({
    name: "delete_tube_memory",
    capability: "items:process",
    title: "Delete tube memory",
    description:
      "Delete one memory block of a tube (memoryId from get_tube_context), e.g. when it is outdated or wrong. Returns { deleted: true, data: <the removed block> }.",
    input: MemoryIdArgSchema,
    annotations: { destructiveHint: true, idempotentHint: false },
    run: async (services, args) => {
      const { tubeId, memoryId } = splitTubeArgs(args)
      return {
        deleted: true,
        data: await services.tubes.deleteMemory(tubeId, memoryId!),
      }
    },
  }),
  defineTool({
    name: "move_tube",
    capability: "structure:manage",
    title: "Move tube",
    description:
      "Move a tube to another existing folder, or to the top level with folderId: null. Returns { data: Tube }.",
    input: IdArgSchema.extend(MoveTubeArgsSchema.shape),
    annotations: { idempotentHint: true },
    run: async (services, args) => {
      const { id, rest } = splitId(args)
      const { folderId } = MoveTubeArgsSchema.parse(rest)
      return { data: await services.tubes.move(id, folderId) }
    },
  }),
  defineTool({
    name: "delete_tube",
    capability: "structure:manage",
    title: "Delete tube",
    description:
      "Delete a tube. Without force it must be empty: a tube that still holds (non-deleted) items fails with a conflict. With force: true the tube and all of its items (any status, processing included) are deleted in one atomic write. Returns { deleted: true, id, deletedItems }.",
    input: IdArgSchema.extend({ force: z.boolean().optional() }),
    annotations: { destructiveHint: true, idempotentHint: false },
    run: async (services, args) => {
      const { id, rest } = splitId(args)
      const { force } = z
        .strictObject({ force: z.boolean().optional() })
        .parse(rest)
      const { deletedItems } = await services.tubes.delete(id, { force })
      return { deleted: true, id, deletedItems }
    },
  }),
]
