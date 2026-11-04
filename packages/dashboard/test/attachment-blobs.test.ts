import { expect, spyOn, test } from "bun:test";
import * as sdk from "@vercel/blob";
import { attachmentBlobs } from "../lib/attachment-blobs";

test("the Blob adapter uses private deterministic paths, an env-only token, and returns only the stream", async () => {
  const previous = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = "synthetic-env-only";
  const key = `attachments/widgets/${"a".repeat(64)}`;
  const bytes = new Uint8Array([1, 2, 3]);
  const stream = new Response(bytes).body;
  if (!stream) throw new Error("stream required");
  const blob = {
    url: "https://synthetic.private.blob.vercel-storage.com/image",
    downloadUrl: "https://synthetic.private.blob.vercel-storage.com/image?download=1",
    pathname: key,
    contentType: "image/png",
    contentDisposition: "attachment",
    cacheControl: "private",
    uploadedAt: new Date("2026-04-01"),
    etag: "provider-etag",
    size: 3,
  };
  const put = spyOn(sdk, "put").mockResolvedValue(blob);
  const get = spyOn(sdk, "get").mockResolvedValue({ statusCode: 200, stream, headers: new Headers(), blob });
  const del = spyOn(sdk, "del").mockResolvedValue();
  try {
    await attachmentBlobs.put(key, bytes, "image/png");
    expect(put).toHaveBeenCalledWith(key, bytes, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "image/png",
      token: "synthetic-env-only",
    });
    expect(await attachmentBlobs.get(key)).toBe(stream);
    expect(get).toHaveBeenLastCalledWith(key, { access: "private", useCache: true, token: "synthetic-env-only" });
    await attachmentBlobs.get(key, false);
    expect(get).toHaveBeenLastCalledWith(key, { access: "private", useCache: false, token: "synthetic-env-only" });
    await attachmentBlobs.del(key);
    expect(del).toHaveBeenCalledWith(key, { token: "synthetic-env-only" });
    delete process.env.BLOB_READ_WRITE_TOKEN;
    await expect(attachmentBlobs.put(key, bytes, "image/png")).rejects.toThrow("BLOB_READ_WRITE_TOKEN is required");
    expect(put).toHaveBeenCalledTimes(1);
  } finally {
    put.mockRestore();
    get.mockRestore();
    del.mockRestore();
    if (previous === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previous;
  }
});
