import { apiHandler } from "@mcpocket/core/api/handler"

/** GET /api/folders/tree — full nested hierarchy + top-level tubes (`rootTubes`) */
export const GET = apiHandler(async ({ services }) => {
  const { folders, tubes } = await services.folders.hierarchy()
  return { data: folders, rootTubes: tubes }
})
