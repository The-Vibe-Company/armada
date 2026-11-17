import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSharedArtifactDir, sharedArtifactWarmer } from "../src/artifact-cache.ts";

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const codex = new TextEncoder().encode("codex archive fixture");
const claude = new TextEncoder().encode("claude archive fixture");
const runtime = "a".repeat(64);
const pin = (bytes: Uint8Array) => ({ sha256: sha(bytes), bytes: bytes.byteLength });

async function fixture(set: unknown, status = 200) {
  const root = await mkdtemp(join(tmpdir(), "armada-host-shared-"));
  const sharedDir = (await prepareSharedArtifactDir(join(root, "artifact-cache")))!;
  const privateDir = join(root, "private");
  await mkdir(privateDir, { mode: 0o700 });
  const urls: string[] = [];
  const bodies = new Map([
    [sha(codex), codex],
    [sha(claude), claude],
  ]);
  const request = (async (url: string | URL | Request, options?: RequestInit) => {
    urls.push(String(url));
    expect(options?.redirect).toBe("error");
    expect(options?.credentials).toBe("omit");
    const path = new URL(String(url)).pathname;
    if (path === `/api/runtime/artifact-sets/${runtime}`) return Response.json(set, { status });
    const body = bodies.get(path.slice("/api/runtime/artifacts/".length));
    return body ? new Response(body) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const warm = sharedArtifactWarmer({ serverUrl: "https://armada.example", privateDir, sharedDir }, request);
  return { root, sharedDir, privateDir, urls, warm, bodies };
}

test("the host publishes the deployment's verified artifacts read-only by digest and prunes stale ones", async () => {
  const f = await fixture({ runtime: { sha256: runtime, bytes: 1 }, artifacts: [pin(codex), pin(claude)] });
  try {
    expect((await lstat(f.sharedDir)).mode & 0o777).toBe(0o755);
    await writeFile(join(f.sharedDir, "f".repeat(64)), "previous deployment");
    await Promise.all([f.warm(runtime), f.warm(runtime)]);
    expect((await readdir(f.sharedDir)).sort()).toEqual([sha(codex), sha(claude)].sort());
    for (const bytes of [codex, claude]) {
      const target = join(f.sharedDir, sha(bytes));
      expect(new Uint8Array(await readFile(target))).toEqual(bytes);
      expect((await lstat(target)).mode & 0o777).toBe(0o444);
    }
    // The second, queued run for the same digest does no network work.
    expect(f.urls).toHaveLength(3);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an old server, a foreign set or wrong bytes publish nothing and never reject", async () => {
  for (const [set, status] of [
    [{}, 404],
    [{ runtime: { sha256: "b".repeat(64), bytes: 1 }, artifacts: [pin(codex)] }, 200],
    [{ runtime: { sha256: runtime, bytes: 1 }, artifacts: [pin(codex)], extra: true }, 200],
    [{ runtime: { sha256: runtime, bytes: 1 }, artifacts: [{ ...pin(codex), bytes: codex.byteLength + 1 }] }, 200],
  ] as const) {
    const f = await fixture(set, status);
    try {
      await f.warm(runtime);
      expect(await readdir(f.sharedDir)).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});
