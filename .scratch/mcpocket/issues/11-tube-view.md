# 11: Tube view

**What to build:** Selecting a tube shows its status counters (total, pending, processing, completed, failed, archived) and a paginated item table the admin can filter by status, agent, creation date, priority, tags and JSON payload fields.

**Blocked by:** 08 — Search, filtering & bulk ops; 09 — Statistics & monitoring; 10 — Dashboard shell + folder explorer

**Status:** done

- [x] Counters come from tube statistics; clicking a counter applies that status filter
- [x] Filters reflected in the URL (shareable, back-button friendly)
- [x] Table shows id, status, priority, tags, assigned agent, attempts, created/updated
- [x] Tube settings (name, description, enabled, schema) editable from this view
- [x] Empty and loading states
