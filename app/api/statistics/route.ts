import { apiHandler } from "@mcpocket/core/api/handler"

/** GET /api/statistics — global item counts by status + entity totals → { data: GlobalStatistics } */
export const GET = apiHandler(async ({ services }) => ({
  data: await services.statistics.global(),
}))
