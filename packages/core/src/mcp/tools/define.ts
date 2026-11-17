import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

import type { Capability } from "../../domain/access"
import { IdSchema } from "../../domain/schemas"
import type { Services } from "../../services"

/**
 * One MCP tool. `input` is built from the shared Zod schemas the services use
 * and is only *advertised* (as JSON Schema) to clients: arguments are passed
 * to `run` as received and validated by the services themselves, so a bad
 * argument produces exactly the same `validation_error` as the REST API.
 */
export type McpToolDefinition = {
  name: string
  title?: string
  description: string
  input: z.ZodType
  annotations?: ToolAnnotations
  /**
   * Capability the caller's role needs (RBAC): tools/list only advertises
   * tools the caller may use (default "read"). The services enforce it
   * again on every call.
   */
  capability?: Capability
  /** Calls application services; the returned object becomes the tool result. */
  run: (services: Services, args: Record<string, unknown>) => Promise<unknown>
}

export const defineTool = (tool: McpToolDefinition) => tool

/** `{ id }` part of a tool's arguments, validated like a REST path id. */
export const IdArgSchema = z.object({ id: IdSchema })

/** Splits `{ id, ...rest }`; throws `ZodError` (→ validation_error) on a bad id. */
export function splitId(args: Record<string, unknown>): {
  id: string
  rest: Record<string, unknown>
} {
  const { id, ...rest } = args
  return { id: IdArgSchema.parse({ id }).id, rest }
}

/** Advertised JSON Schema (MCP `inputSchema`) for a tool's Zod input. */
export function toInputJsonSchema(schema: z.ZodType): {
  type: "object"
  [key: string]: unknown
} {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop the dialect marker
  const { $schema, ...json } = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>
  return { ...json, type: "object" }
}
