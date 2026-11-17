import { apiHandler } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** GET /api/statistics/tubes/{id} → { data: TubeStatistics } (alias: /api/tubes/{id}/statistics) */
export const GET = apiHandler<Params>(async ({ services, params }) => ({
  data: await services.statistics.tube(params.id),
}))
