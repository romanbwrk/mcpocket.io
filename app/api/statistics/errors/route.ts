import { apiHandler, queryObject } from "@mcpocket/core/api/handler"

/**
 * GET /api/statistics/errors?tubeId=&agentId=&status=failed,retry&offset=&limit=
 * → PageResult<ProcessingErrorEntry> (failed items by default, newest failure first)
 */
export const GET = apiHandler(({ services, url }) =>
  services.statistics.errors(queryObject(url))
)
