import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

async function invoke(args: string[], serve: (request: Request) => Response) {
  let out = "";
  let err = "";
  const io = { out: (s: string) => (out += s), err: (s: string) => (err += s) };
  const code = await run(args, io, {
    stdoutIsTTY: false,
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

test("outputs downloads a named binary file to the requested directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "armada-outputs-"));
  const bytes = Uint8Array.of(0, 255, 10);
  try {
    const result = await invoke(["outputs", name, "-o", dir], (request) => {
      expect(new URL(request.url).pathname).toBe(`/api/v1/sandboxes/${id}/outputs/notes%20%231.bin`);
      return new Response(bytes);
    });
    expect(result.code).toBe(0);
    const path = join(dir, name);
    expect(JSON.parse(result.out)).toEqual({ path });
    expect(await Bun.file(path).bytes()).toEqual(bytes);
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
