import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    // Rate limits are process-wide; tests that need them enable them explicitly.
    env: {
      MCPOCKET_RATE_LIMIT_PER_MINUTE: "0",
      MCPOCKET_LOGIN_MAX_ATTEMPTS: "0",
    },
  },
})
