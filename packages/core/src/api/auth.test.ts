import { describe, expect, it } from "vitest"

import {
  apiKeysFromEnv,
  authenticatePrincipal,
  authenticateRequest,
  parseApiKeys,
} from "./auth"
import { hashSecretHex, parseApiKeyRoles } from "../auth/api-keys"
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../domain/errors"
import type { ApiKeyRecord } from "../domain/schemas"

const keys = parseApiKeys("ci:alpha,\n agents : beta:with:colons ")
const request = (headers: Record<string, string>) =>
  new Request("http://localhost/api", { headers })
const noManaged = { managedKeys: async () => [] }
const ADMIN = { role: "admin", scope: null }

const managedKey = (overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  id: "scoped",
  role: "agent",
  scope: { folderIds: ["00000000-0000-4000-8000-000000000001"], tubeIds: [] },
  agentId: null,
  rateLimitPerMinute: 5,
  secretHash: hashSecretHex("mcp_managed"),
  secretPrefix: "mcp_mana",
  createdBy: "user:admin",
  revokedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
})

describe("API-key auth", () => {
  it("parses keyId:secret pairs without exposing secrets in errors", () => {
    expect(keys.map((k) => k.id)).toEqual(["ci", "agents"])
    expect(parseApiKeys("")).toEqual([])
    expect(() => parseApiKeys("ci:alpha,leaked-secret")).toThrow(/entry #2/)
    expect(() => parseApiKeys("leaked-secret")).not.toThrow(/leaked/)
  })

  it("resolves the actor from the key and optional agent id", async () => {
    const opts = { envKeys: keys, ...noManaged }
    expect(
      await authenticateRequest(
        request({ authorization: "Bearer alpha" }),
        opts
      )
    ).toEqual({ kind: "api_key", id: "ci", access: ADMIN })
    expect(
      await authenticateRequest(
        request({ "x-api-key": "beta:with:colons", "x-agent-id": "bot-1" }),
        opts
      )
    ).toEqual({ kind: "agent", id: "bot-1", viaKeyId: "agents", access: ADMIN })
  })

  it("rejects missing, unknown and malformed credentials", async () => {
    const opts = { envKeys: keys, ...noManaged }
    for (const headers of <Record<string, string>[]>[
      {},
      { authorization: "Bearer nope" },
      { authorization: "Basic alpha" },
    ]) {
      await expect(authenticateRequest(request(headers), opts)).rejects.toThrow(
        UnauthorizedError
      )
    }
    await expect(
      authenticateRequest(request({ "x-api-key": "alpha" }), {
        envKeys: [],
        ...noManaged,
      })
    ).rejects.toThrow(UnauthorizedError)
    await expect(
      authenticateRequest(
        request({ "x-api-key": "alpha", "x-agent-id": "bad id!" }),
        opts
      )
    ).rejects.toThrow(ValidationError)
  })
})

describe("?api_key= query parameter", () => {
  const opts = { envKeys: keys, ...noManaged }
  const at = (url: string, headers: Record<string, string> = {}) =>
    authenticateRequest(new Request(url, { headers }), opts)

  it("authenticates GET and POST requests with the key in the URL", async () => {
    expect(await at("http://localhost/api/tubes?api_key=alpha")).toEqual({
      kind: "api_key",
      id: "ci",
      access: ADMIN,
    })
    expect(
      await authenticateRequest(
        new Request(
          "http://localhost/api/mcp?x=1&api_key=beta%3Awith%3Acolons",
          {
            method: "POST",
            headers: { "x-agent-id": "bot-2" },
          }
        ),
        opts
      )
    ).toMatchObject({ kind: "agent", id: "bot-2", viaKeyId: "agents" })
  })

  it("lets headers win and rejects unknown keys", async () => {
    await expect(
      at("http://localhost/api?api_key=alpha", { authorization: "Bearer nope" })
    ).rejects.toThrow(UnauthorizedError)
    await expect(at("http://localhost/api?api_key=nope")).rejects.toThrow(
      UnauthorizedError
    )
    await expect(at("http://localhost/api?api_key=")).rejects.toThrow(
      UnauthorizedError
    )
  })
})

describe("env key roles (backward compatible)", () => {
  it("defaults existing keys to admin and applies MCPOCKET_API_KEY_ROLES", () => {
    const env = {
      MCPOCKET_API_KEYS: "ci:alpha,ro:beta,bot:gamma",
      MCPOCKET_API_KEY_ROLES: "ro:readonly, bot : agent",
    }
    expect(apiKeysFromEnv(env).map((k) => [k.id, k.role])).toEqual([
      ["ci", "admin"],
      ["ro", "readonly"],
      ["bot", "agent"],
    ])
    expect(
      apiKeysFromEnv({ ...env, MCPOCKET_API_KEY_DEFAULT_ROLE: "operator" }).map(
        (k) => k.role
      )
    ).toEqual(["operator", "readonly", "agent"])
  })

  it("rejects unknown roles and malformed entries", () => {
    expect(() => parseApiKeyRoles("ci:superuser")).toThrow(/unknown role/)
    expect(() => parseApiKeyRoles("readonly")).toThrow(/entry #1/)
    expect(() =>
      apiKeysFromEnv({
        MCPOCKET_API_KEYS: "ci:alpha",
        MCPOCKET_API_KEY_DEFAULT_ROLE: "root",
      })
    ).toThrow(/MCPOCKET_API_KEY_DEFAULT_ROLE/)
  })
})

describe("managed keys", () => {
  const opts = (record: ApiKeyRecord) => ({
    envKeys: keys,
    managedKeys: async () => [record],
  })

  it("authenticates with role, scope and per-key rate limit", async () => {
    const record = managedKey()
    const principal = await authenticatePrincipal(
      request({ authorization: "Bearer mcp_managed", "x-agent-id": "a1" }),
      opts(record)
    )
    expect(principal).toEqual({
      keyId: "scoped",
      rateLimitPerMinute: 5,
      actor: {
        kind: "agent",
        id: "a1",
        viaKeyId: "scoped",
        access: { role: "agent", scope: record.scope },
      },
    })
  })

  it("rejects revoked keys", async () => {
    await expect(
      authenticateRequest(
        request({ authorization: "Bearer mcp_managed" }),
        opts(managedKey({ revokedAt: "2026-11-02T00:00:00.000Z" }))
      )
    ).rejects.toThrow(UnauthorizedError)
  })

  it("binds the agent identity of the key", async () => {
    const record = managedKey({ agentId: "bound-bot" })
    expect(
      await authenticateRequest(
        request({ authorization: "Bearer mcp_managed" }),
        opts(record)
      )
    ).toMatchObject({ kind: "agent", id: "bound-bot", viaKeyId: "scoped" })
    await expect(
      authenticateRequest(
        request({ authorization: "Bearer mcp_managed", "x-agent-id": "other" }),
        opts(record)
      )
    ).rejects.toThrow(ForbiddenError)
  })
})
