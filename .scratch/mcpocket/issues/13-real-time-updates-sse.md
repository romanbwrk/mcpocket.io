# 13: Real-time updates (SSE)

**What to build:** When an agent claims or completes an item (via REST, MCP or another dashboard tab), the open dashboard updates its counters, item rows and inspector without a page refresh.

**Blocked by:** 12 — Item inspector

**Status:** done

- [x] Services publish domain events (item created/updated/status changed, folder/tube changed) on an in-process event bus after a successful write
- [x] Authenticated Server-Sent Events endpoint streams events; client subscribes per scope (global / tube / item)
- [x] Tube view counters and rows, inspector and folder tree react to events
- [x] Reconnects automatically; keep-alive pings; no leaked listeners on disconnect
