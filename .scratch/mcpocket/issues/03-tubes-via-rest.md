# 03: Tubes via REST

**What to build:** An API client can create tubes inside folders, configure them (name, description, enabled, optional JSON Schema for payloads), move them between folders and delete empty ones. The folder tree endpoint now includes tubes as leaves.

Endpoints: `GET/POST /api/tubes`, `GET/PATCH/DELETE /api/tubes/{id}`. Moving is a PATCH of `folderId`.

**Blocked by:** 02 — Folders via REST + API-key auth

**Status:** done

- [x] Tube must belong to an existing folder (404/400 otherwise)
- [x] `GET /api/tubes` filterable by folder
- [x] Optional `schemaDefinition` is validated as a JSON Schema on save
- [x] Deleting a tube that still holds (non-deleted) items is rejected (409)
- [x] Deleting a folder that contains a tube is now rejected
- [x] Folder tree includes tubes under their folders
- [x] Tests cover move, delete-only-empty and folder/tube interaction
