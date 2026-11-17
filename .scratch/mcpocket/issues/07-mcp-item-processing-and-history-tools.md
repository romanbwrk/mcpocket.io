# 07: MCP item, processing & history tools

**What to build:** An agent can do a full work loop purely over MCP: push items, browse them, claim the next one, heartbeat, complete or fail it, and read its history. MCP resources expose context agents can read without calling tools.

Tools: `push_item`, `get_item`, `update_item`, `delete_item`, `list_items`, `claim_next_item`, `complete_item`, `fail_item`, `release_item`, `heartbeat_item`, `get_my_items`, `get_item_history`.
Resources: folder tree, tube descriptions (incl. schema), item details, system information.

**Blocked by:** 05 — Claim & lease processing via REST; 06 — MCP server + folder/tube tools

**Status:** done

- [x] All tools available on every transport from 06
- [x] Agent identity for claiming comes from the authenticated MCP session, not a free-form argument the agent can spoof
- [x] Lease-owner rules identical to REST
- [x] Resources listed and readable; item detail resource is templated by id
- [x] End-to-end test: two MCP clients claim from one tube concurrently, each completes different items, history shows both agents
