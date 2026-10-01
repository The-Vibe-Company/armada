export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

export interface Attachment {
  id: string;
  project: string;
  ticket: string;
  kind: "image" | "link";
  contentType: string | null;
  size: number;
  sha256: string;
  caption: string | null;
  author: string;
  createdAt: string;
  reference: string | null;
  url: string | null;
}

export type AttachmentInput = { kind: "image"; bytes: Uint8Array; contentType: string } | { kind: "link"; url: string };

export function attachmentImageType(bytes: Uint8Array): string | null {
  const starts = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts([255, 216, 255])) return "image/jpeg";
  const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (["GIF87a", "GIF89a"].includes(text(0, 6))) return "image/gif";
  if (
    bytes.length >= 16 &&
    text(0, 4) === "RIFF" &&
    text(8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(text(12, 16))
  )
    return "image/webp";
  return null;
}

export function checkAttachment(input: AttachmentInput): string | null {
  if (input.kind === "image") {
    if (input.bytes.length > MAX_ATTACHMENT_BYTES) return "attachment size limit: images must be at most 2 MB each";
    const type = attachmentImageType(input.bytes);
    if (!type || type !== input.contentType)
      return "attachment type limit: only PNG, JPEG, WebP and GIF images matching their bytes are accepted";
    return null;
  }
  try {
    if ([...input.url].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
      return "attachment link type limit: a valid HTTPS URL without control characters is required";
    const url = new URL(input.url);
    if (url.protocol !== "https:") return "attachment link type limit: HTTPS only";
    if (url.username || url.password) return "attachment links must not contain credentials";
    if (input.url.length > 4096) return "attachment link size limit: 4096 characters";
    return null;
  } catch {
    return "attachment link type limit: a valid HTTPS URL is required";
  }
}
