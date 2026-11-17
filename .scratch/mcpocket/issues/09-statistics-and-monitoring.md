# 09: Statistics & monitoring (REST + MCP)

**What to build:** Operators and agents can see how the system is doing: item counts by status globally and per tube, per-agent activity, and a list of failed items with their errors.

REST: `GET /api/statistics`, `GET /api/statistics/tubes/{id}`, `GET /api/tubes/{id}/statistics`, `GET /api/statistics/agents`. MCP: `get_statistics`, `get_tube_statistics`, `get_agent_statistics`, `get_processing_errors`.

**Blocked by:** 07 — MCP item, processing & history tools

**Status:** done

- [x] Status counts (total, pending, processing, completed, failed, retry, cancelled, archived) globally and per tube
- [x] Agent stats: assigned / processing / completed / failed counts and last heartbeat per agent (derived from items + history)
- [x] Processing-errors list is filterable by tube and paginated
- [x] REST and MCP return the same shapes
