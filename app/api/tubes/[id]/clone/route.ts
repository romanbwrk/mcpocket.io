import { apiHandler, created, readJsonBody } from "@mcpocket/core/api/handler"

type Params = { id: string }

/**
 * POST /api/tubes/{id}/clone { name?, folderId?: id|null, includeItems? }
 * → 201 { data: Tube, items: number }. Copies the tube's settings; with
 * `includeItems` also its non-deleted items as fresh `pending` items.
 */
export const POST = apiHandler<Params>(
  async ({ services, params, request }) => {
    const { tube, items } = await services.tubes.clone(
      params.id,
      await readJsonBody(request)
    )
    return created({ data: tube, items })
  }
)
