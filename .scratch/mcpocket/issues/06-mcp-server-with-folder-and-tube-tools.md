# 06: MCP server + folder/tube tools (all transports)

**What to build:** Any MCP-compatible agent can connect to MCPocket and browse/manage folders and tubes. The server identifies as `name: "mcpocket"` and is reachable over every transport:

- **Streamable HTTP** — hosted inside the Next.js app, sharing the same services as REST
- **Legacy HTTP+SSE** — for older MCP clients
- **stdio** — a CLI entry point for local agents (e.g. Claude Desktop / Claude Code config)

Because v1 JSON storage is single-process only, the **stdio process must not open `data/` itself**: it acts as a thin client that forwards to the running app over HTTP with an API key. Decide whether it proxies the MCP HTTP endpoint or calls REST, and record the decision.

Tools: `list_folders`, `create_folder`, `update_folder`, `move_folder`, `delete_folder`, `get_folder_tree`, `list_tubes`, `create_tube`, `update_tube`, `move_tube`, `delete_tube`. (`get_tube_statistics` comes in 09.)

**Blocked by:** 03 — Tubes via REST

**Status:** done

- [x] Uses the official TypeScript MCP SDK; tool input schemas derived from the shared Zod schemas
- [x] HTTP transports require the API key (MCP authentication); the agent/actor identity flows into services
- [x] All tools call the same application services as REST — identical validation and error semantics (errors surface as MCP tool errors)
- [x] stdio entry point runnable via an npm script / bin, configured by env (base URL + API key)
- [x] README snippet shows connecting a client over each transport
- [x] Tests (or a scripted MCP client) exercise at least one tool on each transport

## Decision: stdio proxies MCP Streamable HTTP (not REST)

`bin/mcpocket-stdio.mjs` relays raw JSON-RPC messages between stdio and `<MCPOCKET_URL>/api/mcp` (SDK `StdioServerTransport` ↔ `StreamableHTTPClientTransport`), authenticating with `MCPOCKET_API_KEY` (+ optional `MCPOCKET_AGENT_ID` → `X-Agent-Id`). It never opens `data/`. Rationale: stdio clients get exactly the HTTP tool set, input schemas and error semantics with zero duplicated tool code — tools added later (07, 09, …) appear on stdio automatically. Calling REST would have meant a second tool layer to keep in sync.

Note on validation: tools are served via low-level `tools/list`/`tools/call` handlers (not `McpServer.registerTool`), so arguments are validated by the services with the shared Zod schemas and errors keep the REST `{error:{code,message,details}}` shape; the Zod schemas are advertised as JSON Schema (`z.toJSONSchema`, io: input).
