# @mcpocket/core

The engine behind [MCPocket](https://mcpocket.io): persistent JSON
collections in folders, item claiming with leases, retries, audit history,
webhooks, statistics, REST request handlers and the MCP server and tools.

It has no dependency on Next.js or React. Two apps build on it:

- the open-source, self-hosted server (this repository's root app), and
- MCPocket Cloud (private), which adds tenancy, accounts and billing.

## Modules

Import by path; there is no root barrel.

| Import | Contents |
|---|---|
| `@mcpocket/core/domain/*` | Schemas, statuses, filters, retry policy, errors |
| `@mcpocket/core/storage` | `Storage` interface, JSON and SQLite drivers, config from env |
| `@mcpocket/core/services` | `createServices`, `getServices`: folders, tubes, items, processing, webhooks, statistics |
| `@mcpocket/core/services/lease-sweeper` | Background recovery of expired leases |
| `@mcpocket/core/services/webhook-dispatcher` | Webhook outbox delivery |
| `@mcpocket/core/api/*` | Web-standard `Request` → `Response` handlers, API key auth, rate limiting |
| `@mcpocket/core/auth/*` | API key hashing, signed session tokens |
| `@mcpocket/core/mcp/*` | MCP server, tools, resources, Streamable HTTP and SSE transports |
| `@mcpocket/core/events/*` | In-process domain event bus and SSE helpers |

## Consuming it

The package ships TypeScript source. In Next.js add it to
`transpilePackages`:

```ts
const nextConfig = { transpilePackages: ["@mcpocket/core"] }
```

Requires Node.js 22.13 or later (`node:sqlite`).

## Rules for this package

- No imports from `next`, `react` or the host app. Anything framework
  specific belongs in the app that consumes the core.
- Public behaviour (REST shapes, MCP tool names and arguments) is shared by
  the self-hosted server and the cloud. Treat changes as API changes.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
