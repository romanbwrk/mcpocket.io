import type { Metadata } from "next"

import { TubeContextEditor } from "@/components/dashboard/tube-context-editor"
import { loadTube, TubeHeader } from "@/components/dashboard/tube-header"
import { getUserServices } from "@/lib/auth/server"
import {
  MAX_TUBE_INSTRUCTIONS,
  MAX_TUBE_MEMORY_BLOCKS,
  MAX_TUBE_MEMORY_TEXT,
} from "@mcpocket/core/domain/schemas"

export async function generateMetadata({
  params,
}: PageProps<"/dashboard/tubes/[id]/context">): Promise<Metadata> {
  const { id } = await params
  const services = await getUserServices()
  const tube = await services.tubes.get(id).catch(() => null)
  return {
    title: tube ? `${tube.name} · Instructions & memory` : "Tube not found",
  }
}

/**
 * Tube → Instructions & memory tab: the tube's instructions (how agents
 * should work it, like a skill) and its memory blocks (notes agents and
 * users keep). Agents read both via `get_tube_context`, and tube-scoped MCP
 * connections receive them in the server instructions.
 */
export default async function TubeContextPage({
  params,
}: PageProps<"/dashboard/tubes/[id]/context">) {
  const { id } = await params
  const services = await getUserServices()
  const tube = await loadTube(services, id)

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <TubeHeader services={services} tube={tube} active="context" />
      <TubeContextEditor
        tubeId={tube.id}
        instructions={tube.instructions ?? ""}
        memory={tube.memory ?? []}
        limits={{
          instructions: MAX_TUBE_INSTRUCTIONS,
          blocks: MAX_TUBE_MEMORY_BLOCKS,
          text: MAX_TUBE_MEMORY_TEXT,
        }}
      />
    </div>
  )
}
