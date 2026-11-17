# 08: Search, filtering & bulk operations (REST + MCP)

**What to build:** Clients can find items by any combination of status, assigned agent, creation-date range, priority, tags and JSON payload field values, and can insert or update many items in one call.

REST: filter query params on `GET /api/tubes/{id}/items`, `POST /api/tubes/{id}/items/bulk`, a bulk-update endpoint. MCP: `search_items`, `bulk_push_items`, `bulk_update_items`.

**Blocked by:** 07 — MCP item, processing & history tools

**Status:** done

- [x] Payload-field filter supports dotted paths and equality at minimum (document any other operators)
- [x] Filters combine with pagination and are evaluated in memory
- [x] Bulk push honours idempotency keys and schema validation per item; response reports per-item success/failure
- [x] Bulk update applies the same transition rules as single update and writes one history event per item
- [x] Bulk operations run under one mutex hold and persist once
- [x] Size limit on bulk requests
