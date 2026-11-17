import { generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as prmRoute from "@/app/.well-known/oauth-protected-resource/[[...path]]/route"
import * as mcpRoute from "@/app/api/mcp/route"
import {
  oauthConfigFromEnv,
  resetOAuthJwksCache,
  verifyOAuthToken,
  type OAuthConfig,
} from "@mcpocket/core/auth/oauth"
import { resetStorageSingleton } from "@mcpocket/core/storage"

/**
 * OAuth access tokens on the MCP endpoint (ChatGPT connectors): JWKS
 * verification, the per-workspace grant claim, the 401 challenge and the
 * protected resource metadata.
 */
const ISSUER = "https://auth.test/auth/v1"
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`
const ORIGIN = "https://acme.mcpocket.test"

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
const jwk = (key: KeyObject, kid: string) => ({
  ...(key.export({ format: "jwk" }) as object),
  kid,
  use: "sig",
})
let published = [jwk(rsa.publicKey, "rsa-1"), jwk(ec.publicKey, "ec-1")]
let jwksCalls = 0

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")
function token(
  claims: Record<string, unknown>,
  {
    alg = "RS256",
    kid = "rsa-1",
  }: { alg?: "RS256" | "ES256"; kid?: string } = {}
) {
  const now = Math.floor(Date.now() / 1000)
  const body = `${b64({ alg, kid, typ: "JWT" })}.${b64({
    iss: ISSUER,
    aud: "authenticated",
    sub: "user-123",
    email: "Dana@Example.com",
    client_id: "chatgpt-client",
    iat: now,
    exp: now + 3600,
    mcpocket: { ws: "acme", role: "operator" },
    ...claims,
  })}`
  const sig =
    alg === "RS256"
      ? sign("sha256", Buffer.from(body), rsa.privateKey)
      : sign("sha256", Buffer.from(body), {
          key: ec.privateKey,
          dsaEncoding: "ieee-p1363",
        })
  return `${body}.${sig.toString("base64url")}`
}

const config: OAuthConfig = {
  issuer: ISSUER,
  jwksUrl: JWKS_URL,
  audience: "authenticated",
  workspace: "acme",
  claim: "mcpocket",
}
const fetcher = async (url: string) => {
  expect(url).toBe(JWKS_URL)
  jwksCalls++
  return { keys: published }
}

beforeEach(() => {
  resetOAuthJwksCache()
  published = [jwk(rsa.publicKey, "rsa-1"), jwk(ec.publicKey, "ec-1")]
  jwksCalls = 0
})

describe("verifyOAuthToken", () => {
  it("accepts RS256 and ES256 tokens with a grant for this workspace", async () => {
    expect(await verifyOAuthToken(token({}), config, { fetcher })).toEqual({
      sub: "user-123",
      email: "dana@example.com",
      clientId: "chatgpt-client",
      role: "operator",
      workspace: "acme",
    })
    const es = token(
      { mcpocket: { ws: "acme", role: "agent" } },
      { alg: "ES256", kid: "ec-1" }
    )
    expect((await verifyOAuthToken(es, config, { fetcher })).role).toBe("agent")
    expect(jwksCalls).toBe(1) // cached
  })

  it("rejects bad tokens", async () => {
    const cases: [string, string][] = [
      [token({ iss: "https://evil.test/auth/v1" }), "issuer"],
      [token({ exp: Math.floor(Date.now() / 1000) - 120 }), "expired"],
      [token({ aud: "someone-else" }), "audience"],
      [token({ mcpocket: undefined }), "no MCPocket grant"],
      [
        token({ mcpocket: { ws: "other", role: "operator" } }),
        "another workspace",
      ],
      [token({ mcpocket: { ws: "acme", role: "admin" } }), "role"],
      [token({}).replace(/\.[^.]+$/, ".AAAA"), "bad signature"],
      [token({}, { kid: "missing" }), "unknown signing key"],
    ]
    for (const [t, why] of cases) {
      await expect(
        verifyOAuthToken(t, config, { fetcher }),
        why
      ).rejects.toMatchObject({
        code: "unauthorized",
        message: expect.stringContaining(why),
      })
    }
  })

  it("refetches the JWKS when the key rotates", async () => {
    await verifyOAuthToken(token({}), config, { fetcher })
    const next = generateKeyPairSync("rsa", { modulusLength: 2048 })
    published = [jwk(next.publicKey, "rsa-2")]
    const rotated = (() => {
      const now = Math.floor(Date.now() / 1000)
      const body = `${b64({ alg: "RS256", kid: "rsa-2" })}.${b64({
        iss: ISSUER,
        aud: "authenticated",
        sub: "u",
        exp: now + 60,
        mcpocket: { ws: "acme", role: "readonly" },
      })}`
      return `${body}.${sign("sha256", Buffer.from(body), next.privateKey).toString("base64url")}`
    })()
    // Inside the minimum refresh interval the unknown kid is refused...
    await expect(
      verifyOAuthToken(rotated, config, { fetcher })
    ).rejects.toThrow(/unknown signing key/)
    // ...and accepted once the interval has passed.
    const later = new Date(Date.now() + 60_000)
    expect(
      (await verifyOAuthToken(rotated, config, { fetcher, now: later })).role
    ).toBe("readonly")
  })

  it("reads its configuration from the environment", () => {
    expect(oauthConfigFromEnv({})).toBeNull()
    expect(
      oauthConfigFromEnv({
        MCPOCKET_OAUTH_ISSUER: ISSUER,
        MCPOCKET_SSO_WORKSPACE: "acme",
      })
    ).toEqual({
      issuer: ISSUER,
      jwksUrl: JWKS_URL,
      audience: null,
      workspace: "acme",
      claim: "mcpocket",
    })
  })
})

describe("MCP endpoint with OAuth", () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "mcpocket-oauth-"))
    vi.stubEnv("DATA_DIR", dataDir)
    vi.stubEnv("STORAGE_DRIVER", "json")
    vi.stubEnv("MCPOCKET_API_KEYS", "ci:api-secret")
    vi.stubEnv("MCPOCKET_PUBLIC_URL", ORIGIN)
    vi.stubEnv("MCPOCKET_OAUTH_ISSUER", ISSUER)
    vi.stubEnv("MCPOCKET_OAUTH_AUDIENCE", "authenticated")
    vi.stubEnv("MCPOCKET_OAUTH_WORKSPACE", "acme")
    // Only the JWKS goes through the global fetch; MCP calls use routeFetch.
    vi.stubGlobal("fetch", async (url: string) => {
      expect(url).toBe(JWKS_URL)
      return Response.json({ keys: published })
    })
    await resetStorageSingleton()
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await resetStorageSingleton()
    vi.unstubAllEnvs()
    await rm(dataDir, { recursive: true, force: true })
  })

  const routeFetch = (input: string | URL | Request, init?: RequestInit) =>
    mcpRoute.POST(new Request(input, init))

  async function connect(bearer: string) {
    const client = new Client({ name: "chatgpt-test", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/api/mcp`), {
        fetch: routeFetch,
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      })
    )
    return client
  }
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>
  ) => (await client.callTool({ name, arguments: args })) as CallToolResult

  it("challenges unauthenticated requests with the resource metadata URL", async () => {
    const res = await mcpRoute.POST(
      new Request(`${ORIGIN}/api/mcp`, { method: "POST", body: "{}" })
    )
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`
    )
    const bad = await mcpRoute.POST(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        body: "{}",
        headers: {
          authorization: `Bearer ${token({ mcpocket: { ws: "other", role: "operator" } })}`,
        },
      })
    )
    expect(bad.status).toBe(401)
    expect(bad.headers.get("www-authenticate")).toContain(
      'error="invalid_token"'
    )
  })

  it("lets an operator grant create tubes; readonly cannot", async () => {
    const operator = await connect(token({}))
    const created = await call(operator, "create_tube", {
      name: "From ChatGPT",
    })
    expect(created.isError).toBeFalsy()
    expect(created.structuredContent).toMatchObject({
      data: { name: "From ChatGPT" },
    })
    const info = await operator.readResource({ uri: "mcpocket://system/info" })
    expect(
      JSON.parse((info.contents[0] as { text: string }).text).data.you
    ).toMatchObject({
      kind: "agent",
      id: "oauth:dana@example.com",
      access: { role: "operator" },
    })
    await operator.close()

    const reader = await connect(
      token({ mcpocket: { ws: "acme", role: "readonly" } })
    )
    const { tools } = await reader.listTools()
    expect(tools.map((t) => t.name)).not.toContain("create_tube")
    await reader.close()
  })

  it("still accepts API keys", async () => {
    const client = await connect("api-secret")
    expect((await call(client, "list_tubes", {})).isError).toBeFalsy()
    await client.close()
  })

  it("publishes protected resource metadata", async () => {
    const get = (p: string[] | undefined) =>
      prmRoute.GET(
        new Request(`${ORIGIN}/.well-known/oauth-protected-resource`),
        {
          params: Promise.resolve({ path: p }),
        }
      )
    expect(await (await get(undefined)).json()).toEqual({
      resource: `${ORIGIN}/api/mcp`,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      resource_name: "MCPocket",
    })
    const tube = "0b6f0c1e-3d47-4a3b-9c55-1f2e8a7d9b10"
    expect(
      (await (await get(["api", "mcp", "tubes", tube])).json()).resource
    ).toBe(`${ORIGIN}/api/mcp/tubes/${tube}`)
    expect((await get(["dashboard"])).status).toBe(404)
    vi.stubEnv("MCPOCKET_OAUTH_ISSUER", "")
    expect((await get(undefined)).status).toBe(404)
  })
})
