# 16: Permissions, RBAC & rate limiting

**What to build:** Access is scoped: admins can manage everything, while API keys and agent identities can be restricted to roles and to specific folders/tubes (subtree-inherited). Abusive clients are rate-limited. Enforcement is identical in REST, MCP and the dashboard.

**Blocked by:** 07 — MCP item, processing & history tools; 10 — Dashboard shell + folder explorer

**Status:** done

- [x] Roles (e.g. admin, operator, agent, read-only) with defined capabilities
- [x] API keys / agent identities managed from the dashboard; secrets stored hashed and shown once on creation
- [x] Folder/tube permissions inherited down the tree; enforced in the service layer so every surface gets it
- [x] Listing tools/endpoints only return what the caller can see
- [x] Per-key rate limiting with 429 responses
- [x] Permission and key changes are audit-logged
