# 02: SSO-only mode for managed instances

Part of **cloud-auth**.

**What to build:** An instance run by MCPocket Cloud should never show its own password form. When an SSO login URL is configured, anonymous visitors to the dashboard or the login page are sent to the control plane to sign in, password login can be switched off, and signing out returns the person to the control plane. A self-hosted instance without these settings behaves exactly as today.

**Blocked by:** 01 — SSO token login for the self-hosted dashboard

**Status:** done

- [x] With `MCPOCKET_SSO_LOGIN_URL` set, anonymous requests to `/dashboard/*` and `/login` redirect there, carrying the requested path so the person comes back to it after signing in
- [x] A setting disables password login: the form is hidden and password submissions are rejected server side
- [x] Sign-out clears the session and redirects to the SSO login URL (or a configured sign-out URL)
- [x] The login page explains SSO-only mode instead of showing setup instructions when no admin password is set
- [x] Unset variables: proxy, login page and sign-out behave exactly as before (covered by existing tests plus one new regression test)
- [x] `.env.example` and README document the variables

## Implementation notes

- Core: `packages/core/src/auth/login-mode.ts` (no Next.js imports) — `loginModeFromEnv` → `{ ssoLoginUrl, ssoLogoutUrl, passwordLogin }`, `parseExternalUrl` (absolute http(s), no embedded credentials; invalid values are ignored with a one-time warning), `ssoLoginRedirectUrl(url, next)` (sets `next` only for a `safeRedirectPath` dashboard path, keeps the URL's own params), `signInUrl`, `signOutUrl` (logout URL → login URL → `/login`), `isSelfRedirect` (loop guard: login URL on this origin's `/login` or `/dashboard`).
- Variables: `MCPOCKET_SSO_LOGIN_URL`, `MCPOCKET_SSO_LOGOUT_URL`, `MCPOCKET_PASSWORD_LOGIN` (`false`/`0`/`off`/`no` = off; default on). Return path is passed as `?next=/dashboard/...`; the issuer hands it back to `/auth/sso?next=`, which only honours `/dashboard` paths (no open redirect).
- Password switch: `passwordLoginEnabled` + `AdminConfig.passwordLogin` in `session.ts`; `isAdminConfigured` and `checkAdminCredentials` return false when off, so no password sessions are issued and existing ones stop verifying. SSO sessions are unaffected. `login()` returns "Password sign-in is disabled on this server." before anything else.
- `proxy.ts`: anonymous `/dashboard/*` → SSO URL with `next=<path+query>`; anonymous `/login` → SSO URL with the (safe) `next` from its query. Signed-in behaviour unchanged. `requireSession()` (DAL) redirects to `signInUrl()` too.
- `/login` page: form when password login is usable; otherwise, if SSO is enabled or password login is off, an SSO-only notice (with a "Continue to sign in" link when a login URL is set — only reachable if the proxy's loop guard skipped the redirect); otherwise the old setup notice. The page does not redirect itself, to avoid loops on misconfiguration.
- `logout()` → `signOutUrl()`; SSO error page "Back to sign in" → `signInUrl()` (SSO login URL or `/login`).
- While `MCPOCKET_SSO_LOGIN_URL` is set the password form is unreachable even if password login is on (by design of the first criterion); documented in README.
- Tests: `packages/core/src/auth/login-mode.test.ts`; additions in `session.test.ts`, `sso.test.ts`; `proxy.test.ts` (new; includes the unset-variables regression for proxy); `app/login/actions.test.ts` (sign-out regression to exactly `/login`, SSO/sign-out URLs, password submissions refused, `requireSession`). Checked by hand against `next dev` (redirects with `next`, SSO login with password off, SSO-only notice, unchanged default); sign-out was not clicked in a browser (no browser available) — covered by unit tests only.

