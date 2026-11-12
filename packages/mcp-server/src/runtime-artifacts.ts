import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Route } from "./http.ts";

/** Public executable bytes only, deliberately separate from enrolment/model configuration. */
export function createRuntimeArtifactRoute(directory: string | undefined): Route {
  const root = directory ? resolve(directory) : undefined;
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/runtime/artifacts/")) return null;
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    const digest = path.slice("/api/runtime/artifacts/".length);
    if (!root || !/^[a-f0-9]{64}$/.test(digest)) return new Response(null, { status: 404 });
    const file = join(root, digest);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : Bun.file(file), {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(info.size),
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
          etag: `"${digest}"`,
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}
