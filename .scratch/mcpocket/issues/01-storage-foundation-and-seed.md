# 01: Storage foundation + seed

**What to build:** The persistence layer every other ticket stands on. A developer can run `npm run seed` and get a `data/` directory populated from `mock/seed.json` (Sales / Operations folder hierarchy, a few tubes, items in mixed statuses), and the repository layer can read and write Folders, Tubes, Items and HistoryEvents safely. This is the only horizontal ticket — it is the prefactor that makes every later vertical slice cheap.

Domain model is defined once as Zod schemas with inferred TypeScript types (Folder, Tube, Item, ItemStatus, HistoryEvent — see plan §7.1). Storage is accessed only through a repository interface (FolderRepo, TubeRepo, ItemRepo, HistoryRepo); the v1 implementation is a JSON file adapter selected via `STORAGE_DRIVER=json`. Application services sit on top of the repos and are the single entry point that REST, MCP and the dashboard will all call (REST and MCP will live in the Next.js app as route handlers — no Fastify).

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Zod schemas + inferred types for all four entities and the status enum
- [x] Repository interface for folders, tubes, items and history; adapter chosen by `STORAGE_DRIVER` (only `json` implemented)
- [x] JSON adapter loads into memory once per process, persists after each write via `*.tmp` + `rename`, and serialises all writes through a single in-process mutex/queue
- [x] Adapter instance is a process-wide singleton that survives Next.js dev hot reload (no double-loading, no lost writes)
- [x] `npm run seed` resets `data/` from `mock/seed.json`; `data/` is git-ignored, `mock/` committed
- [x] A test runner is set up and a **repository contract test suite** exercises the interface (CRUD, ordering, concurrent writes don't lose data) — written against the interface so a future Mongo adapter can reuse it
- [x] `npm run typecheck`, `lint` and tests pass

## Implementation notes

- Domain: `lib/domain/schemas.ts` (Zod schemas + inferred types, `ITEM_STATUSES`, `DatasetSchema`).
- Repos: `lib/storage/types.ts` (`Storage` = `folders`/`tubes`/`items`/`history` + `transaction(fn)` + `close()`); errors in `lib/storage/errors.ts`.
- JSON adapter: `lib/storage/json/json-storage.ts` (copy-on-write transactions serialised by `lib/storage/mutex.ts`, AsyncLocalStorage so nested calls join the active transaction), file I/O in `lib/storage/json/files.ts`.
- Singleton: `getStorage()` in `lib/storage/index.ts` (cached on `globalThis`); services entry point `getServices()` in `lib/services/index.ts`.
- Env: `STORAGE_DRIVER` (default `json`), `DATA_DIR` (default `./data`), `SEED_FILE` (seed script only).
- Seed: `npm run seed` → `scripts/seed.ts` + `lib/storage/seed.ts` (validates schema + referential integrity). Restart a running server after seeding.
- Tests: `npm test` (vitest). Contract suite `lib/storage/testing/contract.ts` (`runStorageContract(name, { create, cleanup })`), JSON-specific tests in `lib/storage/json/json-storage.test.ts`.
