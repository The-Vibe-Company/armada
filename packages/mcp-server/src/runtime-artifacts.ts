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

export interface RuntimeArtifactSet {
  runtime: { sha256: string; bytes: number };
  artifacts: { sha256: string; bytes: number }[];
}
const pin = (value: unknown): { sha256: string; bytes: number } | undefined => {
  const v = value as { sha256?: unknown; bytes?: unknown } | null;
  return v &&
    typeof v.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(v.sha256) &&
    Number.isSafeInteger(v.bytes) &&
    (v.bytes as number) > 0 &&
    (v.bytes as number) <= 512 * 1024 * 1024
    ? { sha256: v.sha256, bytes: v.bytes as number }
    : undefined;
};
/** Public digests only (no file inventory, versions or configuration) from one deployed manifest. */
export function runtimeArtifactSet(manifest: unknown): RuntimeArtifactSet | undefined {
  const m = manifest as { runtime?: unknown; harnesses?: unknown; opencode?: unknown } | null;
  const runtime = pin(m?.runtime);
  if (!runtime || !m?.harnesses || typeof m.harnesses !== "object") return undefined;
  const artifacts = new Map<string, { sha256: string; bytes: number }>();
  for (const harness of Object.values(m.harnesses as Record<string, { archive?: unknown } | null>)) {
    const archive = pin(harness?.archive);
    if (archive) artifacts.set(archive.sha256, archive);
  }
  const opencode = pin(m.opencode);
  if (opencode) artifacts.set(opencode.sha256, opencode);
  return { runtime, artifacts: [...artifacts.values()] };
}

/**
 * `GET /api/runtime/artifact-sets/<runtime sha256>` lets a Docker host warm its shared cache with the
 * public artifacts deployed alongside the runtime it was asked to bootstrap (#2562). Unknown digests
 * are 404; the response is a projection of already-public digest-named bytes, never credentials.
 */
export function createRuntimeArtifactSetRoute(manifest: unknown): Route {
  const set = runtimeArtifactSet(manifest);
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/runtime/artifact-sets/")) return null;
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
    if (!set || path.slice("/api/runtime/artifact-sets/".length) !== set.runtime.sha256)
      return new Response(null, { status: 404 });
    return Response.json(set, {
      headers: { "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
    });
  };
}
