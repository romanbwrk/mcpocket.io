import {
  apiHandler,
  created,
  queryObject,
  readJsonBody,
} from "@mcpocket/core/api/handler"

/** GET /api/folders?parentId=<id>|root&offset=&limit= */
export const GET = apiHandler(({ services, url }) => {
  const { parentId, ...rest } = queryObject(url)
  return services.folders.list({
    ...rest,
    ...(parentId !== undefined && {
      parentId: parentId === "root" || parentId === "null" ? null : parentId,
    }),
  })
})

/** POST /api/folders { name, description?, parentId? } */
export const POST = apiHandler(async ({ services, request }) =>
  created({ data: await services.folders.create(await readJsonBody(request)) })
)
