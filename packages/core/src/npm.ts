import { CLI_PACKAGE, compareVersions } from "./armada-api.ts";
import { type Fetch, networkReason } from "./linear.ts";

export const ARMADA_PACKAGE = CLI_PACKAGE;
export const NPM_REGISTRY_URL = `https://registry.npmjs.org/${ARMADA_PACKAGE.replace("/", "%2f")}`;
export const NPM_CHECK_MS = 3_000;

export type NpmCheck =
  | { state: "published" }
  | { state: "missing"; newest: string | null }
  | { state: "unknown"; reason: string };

export async function checkPublished(version: string, fetch: Fetch, timeoutMs = NPM_CHECK_MS): Promise<NpmCheck> {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await fetch(NPM_REGISTRY_URL, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      cache: "no-store",
      signal,
    });
    if (!res.ok) return { state: "unknown", reason: `npm answered HTTP ${res.status}` };
    const body = (await res.json()) as { versions?: Record<string, { dist?: { tarball?: unknown } } | null> } | null;
    const versions = body?.versions;
    if (!versions || typeof versions !== "object" || Array.isArray(versions) || !Object.keys(versions).length)
      return { state: "unknown", reason: "npm listed no version" };
    const candidates = Object.keys(versions)
      .filter((candidate) => /^\d+\.\d+\.\d+$/.test(candidate) && compareVersions(candidate, version) <= 0)
      .sort((first, second) => compareVersions(second, first));
    for (const candidate of candidates) {
      const tarball = versions[candidate]?.dist?.tarball;
      if (typeof tarball !== "string" || !tarball) continue;
      const download = await fetch(tarball, { method: "HEAD", cache: "no-store", signal });
      if (download.status === 200)
        return candidate === version ? { state: "published" } : { state: "missing", newest: candidate };
      if (download.status !== 404) return { state: "unknown", reason: `npm tarball answered HTTP ${download.status}` };
    }
    return { state: "missing", newest: null };
  } catch (err) {
    return { state: "unknown", reason: networkReason(err, timeoutMs) };
  }
}
