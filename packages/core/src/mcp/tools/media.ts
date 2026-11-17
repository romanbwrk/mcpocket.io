import {
  CreateMediaLinksInputSchema,
  CreateUploadInputSchema,
  MAX_LINK_URLS,
  IngestMediaInputSchema,
  MAX_INGEST_URLS,
} from "../../services"

import { defineTool } from "./define"

/** Media tools: get files that are not in the conversation into storage. */
export const mediaTools = [
  defineTool({
    name: "ingest_media",
    capability: "items:push",
    title: "Ingest media from URL",
    description: `Download files from http(s) URLs into media storage and get permanent URLs back. Use it for media an image/video/audio generator or any website hands you as a link (often short-lived) — never re-encode such files as data URIs. Pass url, or urls (≤ ${MAX_INGEST_URLS}; each a URL or { url, contentType?, filename? }). Put the returned data.url into item payloads / complete_item next. URLs already in media storage come back unchanged (reused: true). Only public hosts are fetched; size and type limits are those of mcpocket://system/info → media. Returns { results: [{ index, ok: true, data: { url, sourceUrl, key, contentType, size, sha256, filename? } } | { index, ok: false, sourceUrl, error }], summary: { total, succeeded, failed } }.`,
    input: IngestMediaInputSchema,
    run: (services, args) => services.media.ingest(args),
  }),
  defineTool({
    name: "create_media_link",
    capability: "read",
    title: "Create media link",
    description: `Media stored here is private: its URLs only open with an API key or a dashboard session. To give a file to anything without your API key — an image/video generator (e.g. an image as a video's first frame), a social network, a player, a person — get a temporary signed link: pass url or urls (≤ ${MAX_LINK_URLS}) of stored media and expiresInSeconds (60..604800, default 3600). Hand out data.link; keep storing data.url (the permanent URL) in items. If media is public the URL comes back unchanged (expiresAt null). Returns { results: [{ index, ok: true, data: { url, link, expiresAt } } | { index, ok: false, url, error }], summary }.`,
    input: CreateMediaLinksInputSchema,
    annotations: { readOnlyHint: true },
    run: async (services, args) => services.media.createLinks(args),
  }),
  defineTool({
    name: "create_media_upload",
    capability: "items:push",
    title: "Create media upload link",
    description:
      "Get a short-lived signed URL to upload ONE local file (e.g. a file you rendered or downloaded in your shell) without an API key: run the returned curl command (replace FILE with the path), or PUT the raw bytes with the Content-Type header. The response body is { data: { url, ... } } — put data.url into item payloads. Set contentType to lock the upload's type; expiresInSeconds 60..3600 (default 900). Returns { data: { uploadUrl, method, headers, expiresAt, maxBytes, allowedTypes, curl } }.",
    input: CreateUploadInputSchema,
    run: async (services, args) => ({
      data: services.media.createUploadLink(args),
    }),
  }),
]
