import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@armada/core";
import { launchEnvelope } from "@armada/core/contract";
import { compile, hostTarget } from "../../../scripts/build.ts";

let dir: string;
let binary: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "armada-binary-"));
  binary = compile(hostTarget(), join(dir, "armada"));
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the compiled binary prints the version", () => {
  const result = Bun.spawnSync([binary, "--version"], { env: {} });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(`${VERSION}\n`);
});

test("compiled launch preserves account selection and owner defaults without allocating resources", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const credentialId = "33333333-3333-4333-8333-333333333333";
  const receipt = launchEnvelope.parse({
    sandbox: {
      id: "sandbox",
      provider: "boat",
      providerSandboxId: "bx_fixture",
      harness: "codex",
      status: "ready",
      conversationIds: [],
      credentialId,
      credentialVersion: 2,
    },
    golden: { id: "golden", name: "fixture", visibility: "org" },
    github: { status: "not_connected" },
    ttlSeconds: 600,
    expiresAt: null,
    promptId: null,
    conversationId: null,
    helper: null,
    runtime: null,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({ path, body: (await request.json()) as Record<string, unknown> });
      if (path !== "/api/v1/sandbox/launch") return Response.json({}, { status: 404 });
      return Response.json(receipt);
    },
  });
  try {
    for (const selection of [[], ["--no-connections"], ["--connections", "connection-a"]]) {
      const child = Bun.spawn(
        [
          binary,
          "new",
          "fixture",
          "--provider",
          "boat",
          "--agent",
          "codex",
          "--credential-id",
          credentialId,
          "--json",
          ...selection,
        ],
        {
          env: {
            ARMADA_URL: `http://127.0.0.1:${server.port}`,
            ARMADA_TOKEN: "fixture",
            XDG_CONFIG_HOME: join(dir, "config"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual(receipt);
      expect(stderr).toBe("");
      const request = requests.at(-1)!;
      expect(request.path).toBe("/api/v1/sandbox/launch");
      expect(request.body.credentialId).toBe(credentialId);
      expect(request.body).not.toHaveProperty("visibility");
      if (!selection.length) expect(request.body).not.toHaveProperty("connections");
      else expect(request.body.connections).toEqual(selection[0] === "--no-connections" ? [] : ["connection-a"]);
    }
    expect(requests).toHaveLength(3);
  } finally {
    server.stop(true);
  }
});
