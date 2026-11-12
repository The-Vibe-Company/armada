import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRuntimeArtifact } from "../../agent-runtime/src/artifact-cache.ts";
import { createRuntimeArtifactRoute } from "../src/runtime-artifacts.ts";

// Owner boundary: real route + filesystem cache, fake transport only (no sockets, clocks or inference).
test("runtime bootstrap downloads only missing/corrupt digests and publishes verified executable bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-artifacts-"));
  try {
    const bytes = Buffer.from("runtime-artifact\n".repeat(20000));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const published = join(root, "published");
    await mkdir(published);
    await writeFile(join(published, sha256), bytes);
    const route = createRuntimeArtifactRoute(published);
    const requests: string[] = [];
    const fetcher: NonNullable<Parameters<typeof installRuntimeArtifact>[1]> = async (url, options) => {
      requests.push(String(url));
      expect(options?.redirect).toBe("error");
      expect(options?.credentials).toBe("omit");
      expect(options?.headers).toBeUndefined();
      const response = await route(new Request(String(url), options));
      if (!response) throw Error("route_missing");
      return response;
    };
    const input = {
      serverUrl: "https://armada.example",
      cacheDir: join(root, "cache"),
      artifact: { sha256, bytes: bytes.length },
    };
    const target = await installRuntimeArtifact(input, fetcher);
    expect(await readFile(target)).toEqual(bytes);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    await chmod(target, 0o600);
    expect(await installRuntimeArtifact(input, fetcher)).toBe(target);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    expect(requests).toEqual([`https://armada.example/api/runtime/artifacts/${sha256}`]);
    await writeFile(target, Buffer.alloc(bytes.length));
    expect(await installRuntimeArtifact(input, fetcher)).toBe(target);
    expect(await readFile(target)).toEqual(bytes);
    expect(requests).toHaveLength(2);
    expect(await readdir(input.cacheDir)).toEqual([sha256]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unverified or interrupted downloads never replace a cached executable or leave a partial entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-reject-"));
  try {
    const sha256 = createHash("sha256").update("good").digest("hex");
    const input = { serverUrl: "https://armada.example", cacheDir: root, artifact: { sha256, bytes: 4 } };
    const target = join(root, sha256);
    await writeFile(target, "prior-bad-cache");
    for (const response of [
      new Response("evil"),
      new Response("bad"),
      new Response("oversized"),
      new Response(null, { status: 503 }),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.error(Error("connection_lost"));
          },
        }),
      ),
    ]) {
      await expect(installRuntimeArtifact(input, async () => response)).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("prior-bad-cache");
      expect(await readdir(root)).toEqual([sha256]);
    }
    let fetched = false;
    await expect(
      installRuntimeArtifact({ ...input, serverUrl: "http://armada.example" }, async () => {
        fetched = true;
        return new Response("good");
      }),
    ).rejects.toThrow("invalid_runtime_artifact");
    expect(fetched).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact route is opt-in, digest-only, read-only and refuses symlink publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-route-"));
  try {
    const digest = "a".repeat(64);
    const request = (path: string, method = "GET") => new Request(`https://armada.example${path}`, { method });
    const path = `/api/runtime/artifacts/${digest}`;
    expect((await createRuntimeArtifactRoute(undefined)(request(path)))?.status).toBe(404);
    const route = createRuntimeArtifactRoute(root);
    expect(await route(request("/healthz"))).toBeNull();
    expect((await route(request(path, "POST")))?.status).toBe(405);
    expect((await route(request("/api/runtime/artifacts/not-a-digest")))?.status).toBe(404);
    await writeFile(join(root, "private-config"), "not-an-artifact");
    await symlink(join(root, "private-config"), join(root, digest));
    expect((await route(request(path)))?.status).toBe(404);
    await rm(join(root, digest));
    await writeFile(join(root, digest), "bytes");
    const head = await route(request(path, "HEAD"));
    expect(head?.headers.get("content-length")).toBe("5");
    expect(await head?.text()).toBe("");
    expect(await (await route(request(path)))?.text()).toBe("bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
