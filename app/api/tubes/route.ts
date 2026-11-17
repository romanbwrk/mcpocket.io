import {
  apiHandler,
  created,
  queryObject,
  readJsonBody,
} from "@mcpocket/core/api/handler"

/** GET /api/tubes?folderId=<id|null>&offset=&limit= (`null` = top-level tubes) */
export const GET = apiHandler(({ services, url }) =>
  services.tubes.list(queryObject(url))
)

/** POST /api/tubes { folderId?: id|null, name, description?, enabled?, schemaDefinition? } */
export const POST = apiHandler(async ({ services, request }) =>
  created({ data: await services.tubes.create(await readJsonBody(request)) })
)
