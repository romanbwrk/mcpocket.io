# 01: SSO token login for the self-hosted dashboard

Part of **cloud-auth** (tickets 03–08 live in the `mcpocket-cloud` repo under `.scratch/cloud-auth/issues/`).

**What to build:** A trusted external system (MCPocket Cloud's control plane, or a self-hoster's own identity provider) can sign a person into the dashboard without a password. It sends the browser to the instance's SSO endpoint with a short-lived signed token; the instance verifies it and starts a normal dashboard session for that person. The person is recorded as `user:<email>` in audit history, not `user:admin`.

The feature is generic and lives in the open-source edition. It knows nothing about Supabase. It is off unless `MCPOCKET_SSO_SECRET` is set.

Token claims (decision from design discussion):

```ts
type SsoClaims = {
  sub: string   // email, becomes the session username
  ws?: string   // workspace slug; when MCPOCKET_SSO_WORKSPACE is set it must match
  jti: string   // unique id, single use
  iat: number
  exp: number   // at most 60 s after iat
}
// HMAC-SHA256 over the payload with MCPOCKET_SSO_SECRET, compact JWT (HS256)
```

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Token verification lives in `@mcpocket/core` (no Next.js imports) and rejects: bad signature, wrong algorithm, expired, `exp` more than 60 s after `iat`, missing `sub`, workspace mismatch, reused `jti`
- [x] Replay protection: a used `jti` is remembered until its expiry (in memory is fine; one replica per instance)
- [x] A valid token sets the same signed session cookie as password login, with the email as username, then redirects to `/dashboard` (or a safe `next` path)
- [x] Invalid tokens show a calm, specific error page with a link back to sign in; no session is created
- [x] Dashboard actions after SSO login appear in item history as `user:<email>`
- [x] Password login keeps working when SSO is enabled
- [x] With `MCPOCKET_SSO_SECRET` unset the SSO endpoint returns 404
- [x] A script mints a test token from the secret so the flow can be checked by hand without the cloud
- [x] Unit tests for every rejection case; route test for the happy path and replay
- [x] `.env.example` and README document the variables

## Implementation notes

- Core: `packages/core/src/auth/sso.ts` — `ssoConfigFromEnv`, `verifySsoToken` (header `alg` must be `HS256`; checks in order: format → algorithm → signature → times → `sub` → `jti` → workspace → replay; `jti` is only recorded once every other check passed), `signSsoToken`, `SsoReplayCache` (process-wide on `globalThis`, entries pruned after `exp`), user-facing `SSO_ERROR_MESSAGES`. `iat` up to 30 s in the future is tolerated (clock skew); `sub` must look like an email and is lower-cased.
- Sessions: `packages/core/src/auth/session.ts` gains `createSsoSessionToken` / `isSsoSessionConfigured`. SSO sessions use the same cookie/format/TTL with `via: "sso"`, `sub` = email, and a fingerprint bound to the SSO secret (rotating or unsetting `MCPOCKET_SSO_SECRET` ends them; password changes do not). Without an admin password or `MCPOCKET_SESSION_SECRET`, the cookie key is derived from the SSO secret.
- Endpoint: `GET|POST /auth/sso` (`app/auth/sso/route.ts`; `token` + optional `next` as query or form fields) → 303 to `safeRedirectPath(next)`; failures → 303 `/auth/sso/error?reason=<code>` (`app/auth/sso/error/page.tsx`, link back to `/login`). Both 404 without `MCPOCKET_SSO_SECRET`. Responses are `no-store` + `Referrer-Policy: no-referrer`.
- DAL: `startSsoSession(email)` in `lib/auth/server.ts`; actor stays `user:<session.sub>` → `user:<email>`. SSO users get admin access (no RBAC roles for people yet).
- Script: `npm run sso:token -- <email> [--ws] [--ttl] [--next] [--url]` (`scripts/mint-sso-token.ts`, also `make sso-token EMAIL=…`); reads the secret from env, `.env.local` or `.env`.
- Tests: `packages/core/src/auth/sso.test.ts` (every rejection case, replay cache, SSO sessions), `app/auth/sso/route.test.ts` (happy path, `next`, replay, error redirects, 404, POST, `user:<email>` history, password login alongside SSO). Verified by hand against `next dev` with a minted link.
- For ticket 02: the error page's "Back to sign in" target is the `SIGN_IN_PATH` constant in `app/auth/sso/error/page.tsx` (swap for `MCPOCKET_SSO_LOGIN_URL`); `/login` still shows the setup notice when only SSO is configured; `logout()` in `app/login/actions.ts` redirects to `/login`.
