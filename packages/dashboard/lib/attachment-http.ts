import { type AttachmentInput, MAX_ATTACHMENT_BYTES } from "@armada/core/read";
import { AttachmentRefusal } from "./attachments";

export async function attachmentBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new AttachmentRefusal("attachment request body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 3 * 1024 * 1024) {
        await reader.cancel();
        throw new AttachmentRefusal("attachment size limit: images must be at most 2 MB each", 413);
      }
      chunks.push(part.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AttachmentRefusal) throw err;
    throw new AttachmentRefusal("attachment request must be valid JSON");
  } finally {
    reader.releaseLock();
  }
}

export function attachmentInput(value: unknown): AttachmentInput {
  if (!value || typeof value !== "object")
    throw new AttachmentRefusal("attachment type limit: an image or HTTPS link is required");
  const input = value as Record<string, unknown>;
  if (input.kind === "link" && typeof input.url === "string") return { kind: "link", url: input.url };
  if (input.kind === "image" && typeof input.contentType === "string" && typeof input.data === "string") {
    if (input.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
      throw new AttachmentRefusal("attachment size limit: images must be at most 2 MB each", 413);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data))
      throw new AttachmentRefusal("attachment image must be valid base64");
    return { kind: "image", bytes: Buffer.from(input.data, "base64"), contentType: input.contentType };
  }
  throw new AttachmentRefusal("attachment type limit: an image or HTTPS link is required");
}
