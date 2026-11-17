/**
 * Client-safe media type helpers (dashboard gallery and server code).
 */

/** MIME type → file extension used in object keys. */
export const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/heic": "heic",
  "image/tiff": "tiff",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/ogg": "ogv",
  "video/x-matroska": "mkv",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/json": "json",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
}

const TYPES_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type])
)

/** Content type guessed from an object key's extension (S3 listings carry none). */
export function contentTypeFromKey(key: string): string {
  const ext = key.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase()
  return (ext && TYPES_BY_EXTENSION[ext]) || "application/octet-stream"
}

export const MEDIA_KINDS = [
  "image",
  "video",
  "audio",
  "document",
  "other",
] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

export const MEDIA_KIND_LABELS: Record<MediaKind, string> = {
  image: "Images",
  video: "Videos",
  audio: "Audio",
  document: "Documents",
  other: "Other",
}

const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
])

export function mediaKind(contentType: string): MediaKind {
  const type = contentType.toLowerCase()
  if (type.startsWith("image/")) return "image"
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  if (type.startsWith("text/") || DOCUMENT_TYPES.has(type)) return "document"
  return "other"
}

/** 1536 → "1.5 KB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
