import { apiHandler, queryObject } from "@mcpocket/core/api/handler"

/** GET /api/audit?targetType=&targetId=&offset=&limit= — access audit log (key/permission changes), newest first. Admin only. */
export const GET = apiHandler(({ services, url }) =>
  services.apiKeys.auditLog(queryObject(url))
)
