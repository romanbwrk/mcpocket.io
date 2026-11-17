# 02: Folders via REST + API-key auth

**What to build:** An external client with an API key can manage the folder hierarchy over HTTP. Requests without a valid key get 401. Every request resolves an **actor** (API key id / user / agent id) that services receive, so later audit history knows who did what.

Endpoints (Next.js route handlers): `GET/POST /api/folders`, `GET/PATCH/DELETE /api/folders/{id}`, `GET /api/folders/tree`. Moving a folder is a PATCH of `parentId`.

**Blocked by:** 01 — Storage foundation + seed

**Status:** done

- [x] API keys configured via env (secret not logged or returned); missing/invalid key → 401 with consistent JSON error shape
- [x] Shared request-validation + error-mapping helper (Zod errors → 400, not found → 404, conflict → 409) reused by all later endpoints
- [x] Create, read, rename/describe, move, delete folders; unlimited nesting
- [x] Moving a folder into itself or a descendant is rejected (409)
- [x] Deleting a non-empty folder (has subfolders or tubes) is rejected (409)
- [x] `/api/folders/tree` returns the full nested hierarchy built in memory from `parentId`
- [x] Service-level tests cover cycle prevention and delete-only-empty; route-level smoke test covers auth
