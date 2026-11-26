import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { sandboxOutputOperations } from "@armada/core/contract/sandbox-outputs";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const id = "11111111-1111-4111-8111-111111111111";
const name = "notes #1.bin";
const snapshot = {
  directory: "/home/user/outputs",
  limits: {
    maxFiles: 32,
    maxFileBytes: 32 * 1024 * 1024,
    maxSandboxBytes: 64 * 1024 * 1024,
    maxOrgBytes: 1024 * 1024 * 1024,
  },
  files: [{ name, size: 3, sha256: null, updatedAt: "2026-11-20T00:00:00Z" }],
} satisfies ReturnType<typeof sandboxOutputOperations.listSandboxOutputs.output.parse>;

async function invoke(args: string[], serve: (request: Request) => Response, stdoutIsTTY = false) {
  let out = "";
  let err = "";
  const io = { out: (s: string) => (out += s), err: (s: string) => (err += s) };
  const code = await run(args, io, {
    stdoutIsTTY,
    auth: {
      ...io,
      env: { ARMADA_TOKEN: "fixture", ARMADA_SANDBOX: id },
      session: memorySessionStore(),
      now: () => new Date(0),
      open: () => {},
      fetch: async (url, init) => serve(new Request(String(url), init)),
    },
  });
  return { code, out, err };
}

test("outputs lists the saved snapshot of the current sandbox as JSON", async () => {
  const result = await invoke(["outputs"], (request) => {
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe(`/api/v1/sandboxes/${id}/outputs`);
    return Response.json(snapshot);
  });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual(snapshot);
});

test.each([Uint8Array.of(0, 255, 10), Uint8Array.of()])("outputs saves the exact bytes (%j)", async (bytes) => {
  const dir = await mkdtemp(join(tmpdir(), "armada-outputs-"));
  try {
    const result = await invoke(["outputs", name, "-o", dir], (request) => {
      expect(new URL(request.url).pathname).toBe(`/api/v1/sandboxes/${id}/outputs/notes%20%231.bin`);
      return new Response(bytes.length ? bytes : null, { headers: { "content-length": String(bytes.length) } });
    });
    expect(result.code).toBe(0);
    const path = join(dir, name);
    expect(JSON.parse(result.out)).toEqual({ path });
    expect(await Bun.file(path).bytes()).toEqual(bytes);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outputs rejects an unsafe filename before download", async () => {
  const result = await invoke(["outputs", "../outside"], () => {
    throw new Error("Unexpected request");
  });
  expect(result.code).toBe(2);
  expect(result.err).toContain("Invalid output file name");
});

test("outputs shows the retained snapshot when collection is unavailable", async () => {
  const result = await invoke(
    ["outputs"],
    () => Response.json({ ...snapshot, unavailable: "collector_unsupported" }),
    true,
  );
  expect(result.code).toBe(0);
  expect(result.out).toContain("Output collection is unavailable");
  expect(result.out).toContain(name);
});

test("outputs supports --output alias, rejects conflicting -o/--output, and reports EEXIST clearly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "armada-outputs-alias-"));
  try {
    const first = await invoke(
      ["outputs", name, "--output", dir],
      () => new Response("hi", { headers: { "content-length": "2" } }),
    );
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toEqual({ path: join(dir, name) });

    const duplicate = await invoke(
      ["outputs", name, "--output", dir],
      () => new Response("hi", { headers: { "content-length": "2" } }),
    );
    expect(duplicate.code).toBe(1);
    expect(JSON.parse(duplicate.err).error).toMatchObject({
      code: "conflict",
      message: expect.stringContaining("already exists"),
    });

    const conflict = await invoke(["outputs", name, "-o", dir, "--output", dir], () => {
      throw new Error("Unexpected request");
    });
    expect(conflict.code).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
