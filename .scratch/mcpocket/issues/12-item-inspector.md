# 12: Item inspector

**What to build:** Clicking an item opens an inspector where the admin sees and edits the full JSON payload, views processing results, and operates on the item: change status, reassign agent, retry, cancel, archive or delete — plus the complete audit history timeline.

**Blocked by:** 11 — Tube view

**Status:** done

- [x] JSON editor with syntax highlighting and live validation (parse errors + tube schema errors) before save
- [x] Result and error info shown read-only
- [x] Actions call the same services as REST/MCP; invalid transitions show the server error
- [x] Retry moves item to `retry`; cancel moves to `cancelled` and clears the lease; archive and soft-delete with confirmation
- [x] Reassign agent recorded in history
- [x] History timeline shows action, actor, timestamp and old → new diff
