/**
 * Workspaces (tenants). Two deployment shapes:
 *
 * - **Single workspace** (default, self-hosting; also one-container-per-
 *   tenant clouds): the instance serves one workspace —
 *   `MCPOCKET_WORKSPACE`, else `MCPOCKET_SSO_WORKSPACE`, else none (the
 *   MongoDB driver then uses `default`).
 * - **Multi workspace** (`MCPOCKET_MULTI_WORKSPACE=true`, MCPocket Cloud):
 *   one instance serves every workspace; each request acts in the workspace
 *   of its credential — the SSO session's `ws`, the OAuth grant's `ws`, or
 *   the workspace a managed API key was created in. Password-admin sessions
 *   and env API keys act in the instance workspace above (`default` when
 *   unset). Requires `STORAGE_DRIVER=mongo`.
 *
 * Tenants share backing services: one MongoDB database (documents carry a
 * `workspace` field) and one S3 bucket (objects under
 * `<MCPOCKET_MEDIA_PREFIX><workspace>/`).
 */
type Env = Record<string, string | undefined>

/** Workspace of the MongoDB driver when none is configured. */
export const DEFAULT_WORKSPACE = "default"

const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

export const isWorkspaceSlug = (value: unknown): value is string =>
  typeof value === "string" && WORKSPACE_RE.test(value)

/** Validates a workspace slug (letters, digits, `_`, `.`, `-`; ≤ 128 chars). */
export function assertWorkspace(workspace: string): string {
  if (!isWorkspaceSlug(workspace)) {
    throw new Error(
      `Invalid workspace "${workspace}" (letters, digits, "_", "." or "-"; at most 128 characters)`
    )
  }
  return workspace
}

/** The instance's workspace slug, or `null` when none is configured. */
export function workspaceFromEnv(env: Env = process.env): string | null {
  const ws =
    env.MCPOCKET_WORKSPACE?.trim() || env.MCPOCKET_SSO_WORKSPACE?.trim()
  return ws ? assertWorkspace(ws) : null
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"])

/** `MCPOCKET_MULTI_WORKSPACE`: one instance serves every workspace. */
export function multiWorkspaceEnabled(env: Env = process.env): boolean {
  return TRUE_VALUES.has(
    env.MCPOCKET_MULTI_WORKSPACE?.trim().toLowerCase() ?? ""
  )
}

/**
 * `Actor.workspace` for a credential: its workspace in multi-workspace mode
 * (instance workspace when it has none); `undefined` in single-workspace
 * mode, where everything acts in the instance workspace anyway.
 */
export function actorWorkspace(
  credentialWorkspace: string | null | undefined,
  env: Env = process.env
): string | undefined {
  return multiWorkspaceEnabled(env)
    ? requestWorkspace(credentialWorkspace, env)
    : undefined
}

/**
 * Workspace a request acts in: the credential's workspace in multi-workspace
 * mode, else (and for credentials without one) the instance workspace.
 */
export function requestWorkspace(
  credentialWorkspace: string | null | undefined,
  env: Env = process.env
): string {
  if (multiWorkspaceEnabled(env) && credentialWorkspace) {
    return assertWorkspace(credentialWorkspace)
  }
  return workspaceFromEnv(env) ?? DEFAULT_WORKSPACE
}
