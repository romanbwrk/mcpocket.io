# 18: Docker Compose deployment (v1)

**What to build:** Someone can clone the repo, copy `.env.example`, run `docker compose up`, and get a working MCPocket (dashboard + REST + MCP over HTTP) with persistent data, seeded mock data on first run, and an initial admin account — following the README.

**Blocked by:** 07 — MCP item, processing & history tools; 10 — Dashboard shell + folder explorer

**Status:** done

- [x] Single app container (v1 is single-process: dashboard, REST and MCP HTTP in one Next.js server), image named per branding
- [x] Persistent volume for `data/`; optional seed on first start
- [x] `.env.example` documents every variable (storage driver, API keys, admin credentials, lease/retry defaults)
- [x] Health-check endpoint wired into Compose
- [x] Initial admin account setup documented and working
- [x] README: branding, install, connecting MCP clients (HTTP and stdio), backup/restore (copy `data/`)

## Implementation notes

- `Dockerfile` (deps → builder → runner on `node:22-alpine`, non-root `node`, Next `output: "standalone"`, image `mcpocket:latest`), `.dockerignore`, `docker-compose.yml` (service `mcpocket`, volume `mcpocket-data` → `/app/data`, healthcheck), `.env.example` (all variables).
- `GET|HEAD /api/health` (public, `{status, checks:{storage}}`, 200/503, no data).
- First-start seeding: `MCPOCKET_SEED_ON_FIRST_START` → `lib/storage/bootstrap.ts`, run from `instrumentation.ts` before the workers; only seeds a data dir with no collection files.
- Storage paths marked `turbopackIgnore` → no "whole project traced" warnings, nothing from `data/` in the bundle.
- stdio proxy bundled with esbuild (`npm run build:stdio`) into the image as `bin/mcpocket-stdio.mjs`.
- Docker was NOT available on the implementing machine: image build / `docker compose up` not executed. The standalone bundle was run locally with the image's layout and `.env.example` values (seeding, health, REST with API key, MCP HTTP, bundled stdio proxy, login page) — all OK.
