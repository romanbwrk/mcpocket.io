import { apiHandler, queryObject } from "@mcpocket/core/api/handler"

/** GET /api/statistics/agents?agentId=&offset=&limit= → PageResult<AgentStatistics> */
export const GET = apiHandler(({ services, url }) =>
  services.statistics.agents(queryObject(url))
)
