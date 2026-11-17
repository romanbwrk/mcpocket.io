import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"

export default function AgentNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 py-12">
      <h1 className="text-lg font-semibold">Unknown agent</h1>
      <p className="text-xs text-muted-foreground">
        No item or audit event mentions this agent.
      </p>
      <Link
        href="/dashboard/agents"
        className={buttonVariants({ variant: "outline" })}
      >
        All agents
      </Link>
    </div>
  )
}
