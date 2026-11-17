# 04: Items + audit history via REST

**What to build:** An external platform can push JSON objects into a tube, read, update, soft-delete and page through them, and see a complete audit trail of every change to an item.

Endpoints: `POST /api/tubes/{id}/items`, `GET /api/tubes/{id}/items` (paginated), `GET/PATCH/DELETE /api/items/{id}`, `GET /api/items/{id}/history`.

**Blocked by:** 03 — Tubes via REST

**Status:** done

- [x] Push creates an item with status `pending`, priority, tags, metadata defaults; rejected if tube disabled
- [x] If the tube has a `schemaDefinition`, payload is validated against it (400 with details on failure)
- [x] `idempotencyKey` per tube: repeating a push with the same key returns the original item, does not duplicate
- [x] PATCH updates payload / metadata / tags / priority / status; invalid status transitions rejected
- [x] DELETE is a soft delete (`deletedAt`); soft-deleted items are hidden from lists by default
- [x] Every create / update / status change / delete writes a HistoryEvent with old/new value and actor — item write and history write happen under the same mutex hold
- [x] List supports cursor or offset pagination with stable ordering
- [x] History endpoint returns events newest-first
