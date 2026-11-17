import { getUserServices } from "@/lib/auth/server"
import { AgentsTable } from "@/components/dashboard/agents-table"
import {
  availabilityThresholdsFromEnv,
  formatDuration,
} from "@mcpocket/core/domain/agent-availability"

export const metadata = { title: "Agents" }

/** Upper bound of agents shown; the list is filtered client-side by availability. */
const MAX_AGENTS = 1000

/**
 * Agent monitoring (plan §8.4): every known agent with its assigned /
 * processing / completed / failed counts, last heartbeat and availability.
 * Live updates (ticket 13) refresh the numbers on every item event; the
 * availability badges re-evaluate on a ticking client clock.
 */
export default async function AgentsPage() {
  const services = await getUserServices()
  const thresholds = availabilityThresholdsFromEnv()
  const agents = await services.statistics.agents({ limit: MAX_AGENTS })
  const serverNow = new Date().toISOString()

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Agents</h1>
        <p className="text-xs text-muted-foreground">
          Online = active within {formatDuration(thresholds.onlineSeconds)},
          idle = within {formatDuration(thresholds.staleSeconds)}, stale = older
          (heartbeat or any other agent call). Configure with{" "}
          <code>MCPOCKET_AGENT_ONLINE_SECONDS</code> /{" "}
          <code>MCPOCKET_AGENT_STALE_SECONDS</code>.
        </p>
      </div>
      <AgentsTable
        agents={agents.data}
        thresholds={thresholds}
        serverNow={serverNow}
      />
      {agents.page.total > agents.data.length && (
        <p className="text-xs text-muted-foreground">
          Showing the {agents.data.length} most recently active of{" "}
          {agents.page.total} agents.
        </p>
      )}
    </div>
  )
}
