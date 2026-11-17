import { apiHandler } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** GET /api/tubes/{id}/statistics → { data: TubeStatistics } (alias: /api/statistics/tubes/{id}) */
export const GET = apiHandler<Params>(async ({ services, params }) => ({
  data: await services.statistics.tube(params.id),
}))
