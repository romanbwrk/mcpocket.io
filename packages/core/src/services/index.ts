import type { Actor } from "../domain/actor"
import { getEventBus, workspacePublisher } from "../events/bus"
import { getMediaStore, mediaStoreForWorkspace } from "../media/store"
import { getStorage } from "../storage"
import { multiWorkspaceEnabled } from "../workspace"

import { createApiKeyService } from "./api-keys"
import { createServiceContext, type ServiceContext } from "./context"
import { createFolderService } from "./folders"
import { createItemService } from "./items"
import { createMediaService } from "./media"
import { createProcessingService } from "./processing"
import { createStatisticsService } from "./statistics"
import { createTubeService } from "./tubes"
import { createWebhookService } from "./webhooks"

export * from "./access"
export * from "./api-keys"
export * from "./context"
export * from "./events"
export * from "./folders"
export * from "./history"
export * from "./items"
export * from "./media"
export * from "./processing"
export * from "./retry"
export * from "./statistics"
export * from "./tubes"
export * from "./webhook-outbox"
export * from "./webhooks"

/**
 * Application services: the single entry point for REST route handlers, the
 * MCP server and the dashboard. Each feature service is built from the shared
 * `ServiceContext` plus the `Actor` performing the request, so audit history
 * and permission checks know who did what. Feature tickets add their
 * services here (e.g. `tubes: createTubeService(ctx, actor)`).
 */
export type Services = {
  ctx: ServiceContext
  actor: Actor
  folders: ReturnType<typeof createFolderService>
  tubes: ReturnType<typeof createTubeService>
  items: ReturnType<typeof createItemService>
  media: ReturnType<typeof createMediaService>
  processing: ReturnType<typeof createProcessingService>
  statistics: ReturnType<typeof createStatisticsService>
  apiKeys: ReturnType<typeof createApiKeyService>
  webhooks: ReturnType<typeof createWebhookService>
}

export function createServices(ctx: ServiceContext, actor: Actor): Services {
  return {
    ctx,
    actor,
    folders: createFolderService(ctx, actor),
    tubes: createTubeService(ctx, actor),
    items: createItemService(ctx, actor),
    media: createMediaService(ctx, actor),
    processing: createProcessingService(ctx, actor),
    statistics: createStatisticsService(ctx, actor),
    apiKeys: createApiKeyService(ctx, actor),
    webhooks: createWebhookService(ctx, actor),
  }
}

/**
 * Services on top of the process-wide storage singleton, bound to `actor`.
 * Services themselves are stateless and cheap, so they are rebuilt per
 * request: after a dev hot reload callers get the new service code while
 * still sharing the one already-loaded storage instance. In multi-workspace
 * mode they act in `actor.workspace` (see `workspaceContext`).
 */
export async function getServices(
  actor: Actor,
  overrides: Partial<Omit<ServiceContext, "storage">> = {}
): Promise<Services> {
  return createServices(
    await workspaceContext(actor.workspace, overrides),
    actor
  )
}

/**
 * Service context of a workspace: in multi-workspace mode storage, media
 * prefix and published events are scoped to `workspace`; otherwise (or
 * without a workspace) the instance's own.
 */
export async function workspaceContext(
  workspace: string | undefined,
  overrides: Partial<Omit<ServiceContext, "storage">> = {}
): Promise<ServiceContext> {
  if (!workspace || !multiWorkspaceEnabled()) {
    return createServiceContext(await getStorage(), overrides)
  }
  const media =
    overrides.media !== undefined ? overrides.media : getMediaStore()
  return createServiceContext(await getStorage(workspace), {
    events: workspacePublisher(getEventBus(), workspace),
    ...overrides,
    workspace,
    media: media && mediaStoreForWorkspace(media, workspace),
  })
}

/**
 * Runs `fn` with the service context of every workspace that has documents
 * in `collection` (background jobs); just the instance's own context in
 * single-workspace mode.
 */
export async function forEachWorkspace<R>(
  collection: Parameters<
    NonNullable<ServiceContext["storage"]["listWorkspaces"]>
  >[0],
  fn: (ctx: ServiceContext) => Promise<R>
): Promise<R[]> {
  const storage = await getStorage()
  if (!multiWorkspaceEnabled() || !storage.listWorkspaces) {
    return [await fn(createServiceContext(storage))]
  }
  const results: R[] = []
  for (const workspace of await storage.listWorkspaces(collection)) {
    results.push(await fn(await workspaceContext(workspace)))
  }
  return results
}
