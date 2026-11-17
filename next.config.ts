import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone + server.js) used by the
  // Docker image — see node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md
  output: "standalone",
  // The open-source core ships as TypeScript source (packages/core).
  transpilePackages: ["@mcpocket/core"],
  // Runtime data (DATA_DIR, a Docker volume in production) must never be
  // baked into the bundle. The storage code also marks its dynamic paths with
  // `turbopackIgnore` so the tracer doesn't pull in the whole project.
  outputFileTracingExcludes: {
    "/*": ["./data/**/*"],
  },
  experimental: {
    // Dashboard imports may carry media as data URIs (uploaded to S3 by the
    // Media module). Server actions default to 1 MB; the proxy buffers 10 MB.
    // The import dialog still sends ~800 KB chunks; only an item that is
    // larger on its own needs the headroom.
    serverActions: { bodySizeLimit: "25mb" },
    proxyClientMaxBodySize: "25mb",
  },
}

export default nextConfig
