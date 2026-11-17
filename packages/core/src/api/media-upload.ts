import { PayloadTooLargeError, ValidationError } from "../domain/errors"
import type { MediaFile } from "../media/materialize"

/** Multipart framing allowance on top of the media size limit. */
const MULTIPART_OVERHEAD = 64 * 1024

/**
 * Reads one uploaded file from a request (`POST /api/media`,
 * `PUT /api/media/uploads/{token}`). Two body forms:
 *
 * - raw bytes with the file's `Content-Type` (`?filename=` optional)
 * - `multipart/form-data` with a `file` field (optional `filename` field)
 *
 * 413 when the declared length exceeds the media limit; 400 when empty.
 */
export async function readMediaUpload(
  request: Request,
  status: { enabled: false } | { enabled: true; maxBytes: number }
): Promise<MediaFile> {
  const url = new URL(request.url)
  const contentType = request.headers.get("content-type") ?? ""
  const multipart = contentType.toLowerCase().startsWith("multipart/form-data")
  if (status.enabled) {
    const limit = status.maxBytes + (multipart ? MULTIPART_OVERHEAD : 0)
    const declared = Number(request.headers.get("content-length"))
    if (declared > limit) {
      throw new PayloadTooLargeError(`Media exceeds ${status.maxBytes} bytes`, {
        maxBytes: status.maxBytes,
      })
    }
  }

  let file: MediaFile
  if (multipart) {
    const form = await request.formData().catch(() => {
      throw new ValidationError("Malformed multipart body")
    })
    const part = form.get("file")
    if (!(part instanceof Blob)) {
      throw new ValidationError("Missing `file` field in multipart body")
    }
    const filename =
      (form.get("filename") as string | null) ||
      (part instanceof File ? part.name : "") ||
      undefined
    file = {
      body: new Uint8Array(await part.arrayBuffer()),
      contentType: part.type || "application/octet-stream",
      ...(filename && { filename }),
    }
  } else {
    if (!contentType) {
      throw new ValidationError("Set the file's Content-Type header")
    }
    const filename = url.searchParams.get("filename") || undefined
    file = {
      body: new Uint8Array(await request.arrayBuffer()),
      contentType,
      ...(filename && { filename }),
    }
  }
  if (file.body.byteLength === 0) throw new ValidationError("Empty file")
  return file
}
