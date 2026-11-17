import path from "node:path"

import { headers } from "next/headers"
import Link from "next/link"

import { CopyBlock, CopyButton } from "@/components/dashboard/copy-block"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  McpKeyPicker,
  McpTargetPicker,
  type McpTargetOption,
} from "@/components/dashboard/mcp-target-picker"
import { getUserServices } from "@/lib/auth/server"
import { getMcpOverview, type McpToolInfo } from "@/lib/dashboard/mcp"
import { API_KEY_QUERY_PARAM } from "@mcpocket/core/api/auth"
import { ROLE_META, ROLES } from "@mcpocket/core/domain/access"
import type { Folder, Tube } from "@mcpocket/core/domain/schemas"

export const metadata = { title: "MCP" }

/** Public base URL of this app as seen by the browser (proxy-aware). */
async function requestBaseUrl(): Promise<string> {
  const h = await headers()
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const proto =
    h.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
    (/^(localhost|127\.|\[::1\])/.test(host) ? "http" : "https")
  return `${proto}://${host}`
}

type HierarchyNode = Folder & {
  children: HierarchyNode[]
  tubes: Tube[]
}

type Target = McpTargetOption & { name: string }

/** Every folder and tube with its folder path as label, tree order. */
function connectionTargets(
  folders: HierarchyNode[],
  rootTubes: Tube[]
): Target[] {
  const out: Target[] = rootTubes.map((tube) => ({
    kind: "tube",
    id: tube.id,
    label: tube.name,
    name: tube.name,
  }))
  const walk = (nodes: HierarchyNode[], prefix: string) => {
    for (const node of nodes) {
      const label = `${prefix}${node.name}`
      out.push({ kind: "folder", id: node.id, label, name: node.name })
      for (const tube of node.tubes) {
        out.push({
          kind: "tube",
          id: tube.id,
          label: `${label} / ${tube.name}`,
          name: tube.name,
        })
      }
      walk(node.children, `${label} / `)
    }
  }
  walk(folders, "")
  return out
}

/** `url` with `?api_key=<secret>` (or `&api_key=`) appended. */
const withApiKey = (url: string, secret: string) =>
  `${url}${url.includes("?") ? "&" : "?"}${API_KEY_QUERY_PARAM}=${
    secret.startsWith("<") ? secret : encodeURIComponent(secret)
  }`

const serverKey = (name: string) =>
  `mcpocket-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "scoped"
  }`

/**
 * MCP connection guide and live catalogue: endpoints, auth, client config
 * snippets, and every tool / resource derived from the server definition
 * (lib/mcp), so it never drifts from what clients actually get.
 * `?folder=<id>` / `?tube=<id>` switch endpoints and snippets to a scoped
 * connection (lib/mcp/connection-scope.ts); `?key=<id>` fills in the secret
 * of a key created with "show each time".
 */
export default async function McpPage({
  searchParams,
}: PageProps<"/dashboard/mcp">) {
  const [services, query, baseUrl] = await Promise.all([
    getUserServices(),
    searchParams,
    requestBaseUrl(),
  ])
  const [hierarchy, allKeys] = await Promise.all([
    services.folders.hierarchy(),
    services.apiKeys.list(),
  ])
  const targets = connectionTargets(hierarchy.folders, hierarchy.tubes)
  const param = (key: string) =>
    typeof query[key] === "string" ? query[key] : null
  const keys = allKeys.filter(
    (k) => k.source === "managed" && k.status === "active"
  )
  const selectedKey =
    keys.find(
      (k) => k.id === param("key") && k.secretVisibility === "always"
    ) ?? null
  const keySecret = selectedKey
    ? await services.apiKeys.revealSecret(selectedKey.id)
    : null
  /** Secret for JSON / URLs, and for shell commands. */
  const secret = keySecret ?? "<secret>"
  const shellSecret = keySecret ?? "$MCPOCKET_API_KEY"
  const tubeParam = param("tube")
  const folderParam = param("folder")
  const selected =
    targets.find((t) =>
      tubeParam
        ? t.kind === "tube" && t.id === tubeParam
        : t.kind === "folder" && t.id === folderParam
    ) ?? null

  const mcp = getMcpOverview(
    baseUrl,
    selected ? { kind: selected.kind, id: selected.id } : undefined
  )
  const stdioBin = path.join(process.cwd(), "bin", "mcpocket-stdio.mjs")
  const name = selected ? serverKey(selected.name) : mcp.server.name
  const envVar =
    selected?.kind === "folder" ? "MCPOCKET_FOLDER_ID" : "MCPOCKET_TUBE_ID"
  const tubeEnv: Record<string, string> = selected
    ? { [envVar]: selected.id }
    : {}

  const keyUrls = {
    http: withApiKey(mcp.endpoints.http, secret),
    sse: withApiKey(mcp.endpoints.sse, secret),
    next: withApiKey(
      `${mcp.baseUrl}/api/tubes/${
        selected?.kind === "tube" ? encodeURIComponent(selected.id) : "<tubeId>"
      }/next`,
      secret
    ),
    rest: withApiKey(
      selected?.kind === "tube"
        ? `${mcp.baseUrl}/api/tubes/${encodeURIComponent(selected.id)}/items`
        : `${mcp.baseUrl}/api/folders/tree`,
      secret
    ),
  }

  const snippets = {
    claudeHttp: `claude mcp add --transport http ${name} ${mcp.endpoints.http} \\
  --header "Authorization: Bearer ${shellSecret}" \\
  --header "X-Agent-Id: my-agent"`,
    claudeSse: `claude mcp add --transport sse ${name} "${mcp.endpoints.sse}" \\
  --header "Authorization: Bearer ${shellSecret}"`,
    urlOnly: JSON.stringify(
      { mcpServers: { [name]: { type: "http", url: keyUrls.http } } },
      null,
      2
    ),
    restGet: `curl -s "${keyUrls.rest}"`,
    httpJson: JSON.stringify(
      {
        mcpServers: {
          [name]: {
            type: "http",
            url: mcp.endpoints.http,
            headers: {
              Authorization: `Bearer ${secret}`,
              "X-Agent-Id": "my-agent",
            },
          },
        },
      },
      null,
      2
    ),
    stdio: JSON.stringify(
      {
        mcpServers: {
          [name]: {
            command: "node",
            args: [stdioBin],
            env: {
              MCPOCKET_URL: mcp.baseUrl,
              MCPOCKET_API_KEY: secret,
              MCPOCKET_AGENT_ID: "my-agent",
              ...tubeEnv,
            },
          },
        },
      },
      null,
      2
    ),
    docker: JSON.stringify(
      {
        mcpServers: {
          [name]: {
            command: "docker",
            args: [
              "compose",
              "-f",
              "/path/to/mcpocket/docker-compose.yml",
              "exec",
              "-T",
              "-e",
              `MCPOCKET_API_KEY=${secret}`,
              "-e",
              "MCPOCKET_AGENT_ID=my-agent",
              ...(selected ? ["-e", `${envVar}=${selected.id}`] : []),
              "mcpocket",
              "node",
              "bin/mcpocket-stdio.mjs",
            ],
          },
        },
      },
      null,
      2
    ),
    curl: `curl -s ${mcp.endpoints.http} \\
  -H "Authorization: Bearer ${shellSecret}" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">MCP</h1>
          <Badge variant="outline">
            {mcp.server.name} v{mcp.server.version}
          </Badge>
          <Badge variant="secondary">{mcp.toolCount} tools</Badge>
          <Badge variant="secondary">{mcp.resources.length} resources</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          The Model Context Protocol server runs inside this app and shares the
          REST API&apos;s services, validation, permissions and rate limits.
          Every transport needs an API key from the{" "}
          <Link href="/dashboard/access" className="underline">
            Access
          </Link>{" "}
          page (or <code>MCPOCKET_API_KEYS</code>).
        </p>
      </div>

      <Section title="Connection target">
        <McpTargetPicker
          targets={targets.map(({ kind, id, label }) => ({ kind, id, label }))}
          value={selected ? { kind: selected.kind, id: selected.id } : null}
        />
        {selected?.kind === "tube" && (
          <ScopeCallout>
            <p>
              Tube-scoped connection to{" "}
              <Link
                href={`/dashboard/tubes/${selected.id}`}
                className="font-medium underline"
              >
                {selected.label}
              </Link>{" "}
              <code className="text-muted-foreground">{selected.id}</code>
            </p>
            <ul className="list-disc pl-4 text-muted-foreground">
              <li>
                The session sees only this tube, even with a key that can reach
                more. Keys without access to it get 404.
              </li>
              <li>
                <code>tubeId</code> arguments are optional and default to this
                tube (e.g. <code>claim_next_item {"{}"}</code>).
              </li>
              <li>
                {mcp.tubeScopedToolCount} of {mcp.toolCount} tools: folder tools
                and tube create/move/delete are not offered. Admin keys act as
                operator here.
              </li>
            </ul>
          </ScopeCallout>
        )}
        {selected?.kind === "folder" && (
          <ScopeCallout>
            <p>
              Folder-scoped connection to{" "}
              <span className="font-medium">{selected.label}</span>{" "}
              <code className="text-muted-foreground">{selected.id}</code>
            </p>
            <ul className="list-disc pl-4 text-muted-foreground">
              <li>
                The session sees this folder with all subfolders and tubes below
                it; everything else is invisible (ancestor folders appear by
                name only).
              </li>
              <li>
                <code>create_folder</code> and <code>create_tube</code> put new
                entries into this folder unless <code>parentId</code> /{" "}
                <code>folderId</code> is given. The bound folder itself cannot
                be deleted or moved.
              </li>
              <li>
                All {mcp.toolCount} tools are available; items still need a{" "}
                <code>tubeId</code>. The key must have full access to the folder
                (404 / 403 otherwise). Admin keys act as operator here.
              </li>
            </ul>
          </ScopeCallout>
        )}
        {!selected && (
          <p className="text-xs text-muted-foreground">
            Pick a folder or tube to bind a connection to it: the agent then
            sees only that part of the workspace, with any API key that can
            reach it. To enforce this per key instead, give the key a scope on
            the{" "}
            <Link href="/dashboard/access" className="underline">
              Access
            </Link>{" "}
            page.
          </p>
        )}
      </Section>

      <Section title="API key">
        <McpKeyPicker
          keys={keys.map((k) => ({
            id: k.id,
            label: `${k.id} · ${ROLE_META[k.role].label}${
              k.description ? ` · ${k.description}` : ""
            }`,
            viewable: k.secretVisibility === "always",
          }))}
          value={selectedKey?.id ?? null}
        />
        {selectedKey ? (
          <ScopeCallout>
            <p>
              URLs and snippets below contain the secret of{" "}
              <span className="font-medium">{selectedKey.id}</span>. Treat them
              like a password: URLs with <code>?api_key=</code> can end up in
              browser history, proxy and server logs.
            </p>
          </ScopeCallout>
        ) : (
          <p className="text-xs text-muted-foreground">
            Pick a key to fill its secret into the URLs and snippets below. Only
            keys created with{" "}
            <span className="font-medium">Show each time</span> on the{" "}
            <Link href="/dashboard/access" className="underline">
              Access
            </Link>{" "}
            page can be selected; show-once secrets are not stored.
          </p>
        )}
      </Section>

      <Section title="Endpoints">
        <div className="border">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[36%]">Transport</TableHead>
                <TableHead className="w-20">Method</TableHead>
                <TableHead>URL / command</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <EndpointRow
                transport="Streamable HTTP"
                note={
                  selected
                    ? `Recommended · bound to the selected ${selected.kind}`
                    : "Recommended · stateless, JSON responses"
                }
                method="POST"
                value={mcp.endpoints.http}
              />
              <EndpointRow
                transport="Streamable HTTP · key in URL"
                note="For clients that only take a URL (no headers)"
                method="POST"
                value={keyUrls.http}
              />
              <EndpointRow
                transport="Legacy HTTP+SSE"
                note="Protocol 2024-11-05 clients · event stream"
                method="GET"
                value={mcp.endpoints.sse}
              />
              <EndpointRow
                transport="Legacy HTTP+SSE · key in URL"
                note="EventSource-style clients; the key is passed on to the messages URL"
                method="GET"
                value={keyUrls.sse}
              />
              <EndpointRow
                transport="Next item · key in URL"
                note={`Each call returns only the payload JSON of the next item${
                  selected?.kind === "tube"
                    ? " of this tube"
                    : " (pick a tube above for its URL)"
                } and marks it completed (a single-field payload returns just that value). 204 when empty. Optional &agent_id=.`}
                method="GET"
                value={keyUrls.next}
              />
              <EndpointRow
                transport="REST · key in URL"
                note={
                  selected?.kind === "tube"
                    ? "Any REST GET works with ?api_key= · items of the tube"
                    : "Any REST GET works with ?api_key= · folder tree"
                }
                method="GET"
                value={keyUrls.rest}
              />
              <EndpointRow
                transport="Legacy SSE messages"
                note="Announced by the stream's endpoint event"
                method="POST"
                value={mcp.endpoints.messages}
              />
              <EndpointRow
                transport="stdio"
                note={
                  selected
                    ? `Local proxy · ${envVar} binds it to the ${selected.kind}`
                    : "Local proxy to /api/mcp — the app must be running"
                }
                method="—"
                value={
                  selected
                    ? `${envVar}=${selected.id} node ${stdioBin}`
                    : `node ${stdioBin}`
                }
              />
            </TableBody>
          </Table>
        </div>
      </Section>

      <Section title="Authentication">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Header</TableHead>
                  <TableHead>Meaning</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-mono text-xs">
                    Authorization: Bearer &lt;secret&gt;
                  </TableCell>
                  <TableCell className="text-xs whitespace-normal">
                    API key secret (required)
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-mono text-xs">
                    X-API-Key: &lt;secret&gt;
                  </TableCell>
                  <TableCell className="text-xs whitespace-normal">
                    Alternative to Authorization
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-mono text-xs">
                    ?api_key=&lt;secret&gt;
                  </TableCell>
                  <TableCell className="text-xs whitespace-normal">
                    Query parameter, used when no auth header is sent (GET
                    links, URL-only clients). May be logged — prefer headers.
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-mono text-xs">
                    X-Agent-Id: &lt;id&gt;
                  </TableCell>
                  <TableCell className="text-xs whitespace-normal">
                    Optional: act as a named agent (claims, leases, Agents
                    page). Never a tool argument.
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <div className="border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead>Tools listed</TableHead>
                  <TableHead>Allows</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ROLES.map((role) => (
                  <TableRow key={role}>
                    <TableCell className="text-xs font-medium">
                      {ROLE_META[role].label}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {mcp.toolsPerRole[role]} / {mcp.toolCount}
                    </TableCell>
                    <TableCell className="text-xs whitespace-normal text-muted-foreground">
                      {ROLE_META[role].description}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          <code>tools/list</code> only advertises the tools a key&apos;s role
          grants; a folder/tube scope hides everything outside it. Requests
          count against the key&apos;s rate limit (HTTP 429 with{" "}
          <code>RateLimit-*</code> headers).
        </p>
      </Section>

      <Section title="Connect a client">
        <div className="grid gap-4 lg:grid-cols-2">
          <CopyBlock
            title="Claude Code · Streamable HTTP"
            code={snippets.claudeHttp}
          />
          <CopyBlock
            title="Claude Code · legacy SSE"
            code={snippets.claudeSse}
          />
          <CopyBlock
            title="mcp.json · Streamable HTTP (Cursor, VS Code, …)"
            code={snippets.httpJson}
          />
          <CopyBlock
            title="claude_desktop_config.json · stdio (Node.js)"
            code={snippets.stdio}
          />
          <CopyBlock
            title="claude_desktop_config.json · stdio via Docker"
            code={snippets.docker}
          />
          <CopyBlock title="Smoke test · curl" code={snippets.curl} />
          <CopyBlock
            title="mcp.json · URL only (key in query)"
            code={snippets.urlOnly}
          />
          <CopyBlock title="REST GET · key in query" code={snippets.restGet} />
        </div>
        <p className="text-xs text-muted-foreground">
          The stdio proxy reads <code>MCPOCKET_URL</code>,{" "}
          <code>MCPOCKET_API_KEY</code>, <code>MCPOCKET_AGENT_ID</code> and
          optionally <code>MCPOCKET_TUBE_ID</code> or{" "}
          <code>MCPOCKET_FOLDER_ID</code> (binds it to one tube / folder); it
          never opens the data directory itself. With npm use{" "}
          <code>npm run --silent mcp:stdio</code> — npm&apos;s banner would
          corrupt the protocol stream.
        </p>
      </Section>

      <Section title="Agent work loop">
        <ol className="flex flex-wrap items-center gap-2 text-xs">
          {[
            "claim_next_item",
            "heartbeat_item (before the lease expires)",
            "complete_item | fail_item | release_item",
          ].map((step, i) => (
            <li key={step} className="flex items-center gap-2">
              {i > 0 && <span className="text-muted-foreground">→</span>}
              <code className="border bg-muted/30 px-2 py-1">{step}</code>
            </li>
          ))}
        </ol>
        <details className="border text-xs">
          <summary className="cursor-pointer px-3 py-2 font-medium">
            Server instructions (sent to clients on initialize)
          </summary>
          <p className="border-t px-3 py-2 leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {mcp.server.instructions}
          </p>
        </details>
      </Section>

      <Section title={`Tools (${mcp.toolCount})`}>
        <nav className="flex flex-wrap gap-2 text-xs">
          {mcp.groups.map((group) => (
            <a
              key={group.id}
              href={`#tools-${group.id}`}
              className="border px-2 py-1 hover:bg-muted"
            >
              {group.label} ({group.tools.length})
            </a>
          ))}
        </nav>
        {mcp.groups.map((group) => (
          <div
            key={group.id}
            id={`tools-${group.id}`}
            className="flex scroll-mt-16 flex-col gap-2"
          >
            <h3 className="text-xs font-medium text-muted-foreground uppercase">
              {group.label}
            </h3>
            <div className="flex flex-col divide-y border">
              {group.tools.map((tool) => (
                <ToolEntry key={tool.name} tool={tool} />
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section title={`Resources (${mcp.resources.length})`}>
        <div className="border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>URI</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mcp.resources.map((resource) => (
                <TableRow key={resource.uri}>
                  <TableCell className="align-top font-mono text-xs">
                    <div className="flex items-center gap-1">
                      {resource.uri}
                      <CopyButton value={resource.uri} label="Copy URI" />
                    </div>
                    {resource.template && (
                      <Badge variant="outline" className="mt-1">
                        template
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    {resource.title}
                  </TableCell>
                  <TableCell className="text-xs whitespace-normal text-muted-foreground">
                    {resource.description}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      <Section title="Errors & statuses">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-2 text-xs">
            <p className="text-muted-foreground">
              Tool failures return <code>isError: true</code> with the REST
              error body <code>{"{ error: { code, message, details? } }"}</code>
              . Codes:
            </p>
            <div className="flex flex-wrap gap-1">
              {mcp.errorCodes.map((code) => (
                <Badge key={code} variant="outline" className="font-mono">
                  {code}
                </Badge>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2 text-xs">
            <p className="text-muted-foreground">Item statuses:</p>
            <div className="flex flex-wrap gap-1">
              {mcp.itemStatuses.map((status) => (
                <Badge key={status} variant="secondary" className="font-mono">
                  {status}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </Section>
    </div>
  )
}

function ScopeCallout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border border-primary/40 bg-primary/5 p-3 text-xs">
      {children}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  )
}

function EndpointRow({
  transport,
  note,
  method,
  value,
}: {
  transport: string
  note: string
  method: string
  value: string
}) {
  return (
    <TableRow>
      <TableCell className="text-xs whitespace-normal">
        <div className="font-medium">{transport}</div>
        <div className="text-muted-foreground">{note}</div>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="font-mono">
          {method}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-xs break-all whitespace-normal">
        {value}
      </TableCell>
      <TableCell>
        <CopyButton value={value} />
      </TableCell>
    </TableRow>
  )
}

function ToolEntry({ tool }: { tool: McpToolInfo }) {
  return (
    <details className="group text-xs" id={`tool-${tool.name}`}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 hover:bg-muted/40">
        <span className="text-muted-foreground transition-transform group-open:rotate-90">
          ›
        </span>
        <code className="font-medium">{tool.name}</code>
        {tool.title && (
          <span className="text-muted-foreground">{tool.title}</span>
        )}
        <span className="ml-auto flex flex-wrap gap-1">
          {tool.hints.readOnly && <Badge variant="secondary">read-only</Badge>}
          {tool.hints.idempotent && (
            <Badge variant="secondary">idempotent</Badge>
          )}
          {tool.hints.destructive && (
            <Badge variant="destructive">destructive</Badge>
          )}
          {tool.tubeScoped === "hidden" && (
            <Badge
              variant="outline"
              className="text-muted-foreground"
              title="Not offered on tube-scoped connections"
            >
              not on tube connections
            </Badge>
          )}
          <Badge variant="outline" className="font-mono">
            {tool.capability}
          </Badge>
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t bg-muted/10 px-3 py-3">
        <p className="leading-relaxed">{tool.description}</p>
        <p className="text-muted-foreground">
          Roles: {tool.roles.map((role) => ROLE_META[role].label).join(", ")}
        </p>
        {tool.tubeScoped === "defaults-tube" && (
          <p className="text-muted-foreground">
            On tube-scoped connections <code>tubeId</code> is optional and
            defaults to the connection&apos;s tube.
          </p>
        )}
        {tool.folderScoped.kind === "defaults-folder" && (
          <p className="text-muted-foreground">
            On folder-scoped connections <code>{tool.folderScoped.arg}</code>{" "}
            defaults to the connection&apos;s folder.
          </p>
        )}
        {tool.folderScoped.kind === "protects-folder" && (
          <p className="text-muted-foreground">
            On folder-scoped connections the bound folder itself cannot be
            deleted or moved.
          </p>
        )}
        {tool.params.length > 0 ? (
          <div className="border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Argument</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tool.params.map((param) => (
                  <TableRow key={param.name}>
                    <TableCell className="align-top font-mono text-xs">
                      {param.name}
                      {param.required && (
                        <span className="text-destructive" title="required">
                          *
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="align-top font-mono text-xs whitespace-normal text-muted-foreground">
                      {param.type}
                    </TableCell>
                    <TableCell className="text-xs whitespace-normal text-muted-foreground">
                      {param.description ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-muted-foreground">No arguments.</p>
        )}
        <CopyBlock title="inputSchema (JSON Schema)" code={tool.inputSchema} />
      </div>
    </details>
  )
}
