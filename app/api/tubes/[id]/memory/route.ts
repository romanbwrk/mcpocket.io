import { apiHandler, created, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string }

/** GET /api/tubes/{id}/memory → { data: TubeMemoryBlock[] } (oldest first) */
export const GET = apiHandler<Params>(async ({ services, params }) => ({
  data: (await services.tubes.context(params.id)).memory,
}))

/** POST /api/tubes/{id}/memory { text } → 201 { data: TubeMemoryBlock }. Needs `items:process`. */
export const POST = apiHandler<Params>(async ({ services, params, request }) =>
  created({
    data: await services.tubes.addMemory(
      params.id,
      await readJsonBody(request)
    ),
  })
)
