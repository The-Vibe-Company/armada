import { mock } from "bun:test";
import type { AttachmentBlobs } from "../lib/attachment-blobs";

export function fakeAttachmentBlobs() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    put: mock(async (key: string, bytes: Uint8Array, _contentType: string) => {
      objects.set(key, new Uint8Array(bytes));
    }),
    get: mock(async (key: string, _useCache?: boolean) => {
      const bytes = objects.get(key);
      return bytes ? new Response(new Uint8Array(bytes)).body : null;
    }),
    del: mock(async (key: string) => {
      objects.delete(key);
    }),
  } satisfies AttachmentBlobs & { objects: Map<string, Uint8Array> };
}
