import type { Access } from "./access"

/**
 * Who performs an operation. Every REST/MCP/dashboard request resolves an
 * actor that is bound to the application services (`getServices(actor)`), so
 * audit history (`HistoryEvent.actor`) and later RBAC know who did what.
 */
export type ActorKind = "api_key" | "agent" | "user" | "system"

export type Actor = {
  kind: ActorKind
  /** API key id, agent id, user id or system component name. Never a secret. */
  id: string
  /** For agents acting through an API key: the key id that authenticated them. */
  viaKeyId?: string
  /**
   * Role + scope (RBAC, ticket 16). Set by authentication for API keys;
   * omitted for trusted internal actors (system, tests), which act as admin.
   */
  access?: Access
  /**
   * Workspace the actor acts in (multi-workspace mode, set by
   * authentication); unset = the instance workspace.
   */
  workspace?: string
}

/** Stable string form stored in `HistoryEvent.actor`, e.g. `agent:summarizer-1`. */
export function actorToString(actor: Actor): string {
  return `${actor.kind}:${actor.id}`
}

export const systemActor = (id = "system"): Actor => ({ kind: "system", id })
