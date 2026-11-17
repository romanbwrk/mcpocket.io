import { AccessAuditLog } from "@/components/dashboard/access-audit-log"
import { ApiKeysPanel } from "@/components/dashboard/api-keys-panel"
import { rateLimitPerMinuteFromEnv } from "@mcpocket/core/api/rate-limit"
import { getUserServices } from "@/lib/auth/server"

export const metadata = { title: "Access" }

const AUDIT_LIMIT = 50

/**
 * Access management (ticket 16): API keys / agent identities with role,
 * folder/tube scope, agent binding and rate limit, plus the access audit
 * log. All changes go through `services.apiKeys` (admin only, audited).
 */
export default async function AccessPage() {
  const services = await getUserServices()
  const [keys, audit] = await Promise.all([
    services.apiKeys.list(),
    services.apiKeys.auditLog({ limit: AUDIT_LIMIT }),
  ])

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Access</h1>
        <p className="text-xs text-muted-foreground">
          Roles: admin (everything), operator (data + structure), agent (read,
          push, process), read-only. A scope limits a key to folders (with
          everything below them) and single tubes; out-of-scope data is
          invisible over REST and MCP. Keys from <code>MCPOCKET_API_KEYS</code>{" "}
          are read-only here (role via <code>MCPOCKET_API_KEY_ROLES</code>).
        </p>
      </div>
      <ApiKeysPanel
        keys={keys}
        defaultRateLimit={rateLimitPerMinuteFromEnv()}
      />
      <AccessAuditLog events={audit.data} total={audit.page.total} />
    </div>
  )
}
