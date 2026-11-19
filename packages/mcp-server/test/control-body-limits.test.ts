import { expect, test } from "bun:test";
import { createMemoryAuthStore } from "@armada/auth";
import type { VaultStore } from "@armada/core";
import { isScopedMethod, ORCHESTRATOR_SCOPED_PATH } from "@armada/core/contract";
import type { Sql } from "@armada/core/server";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createGitHubAccountApi } from "../src/github-account.ts";
import { createSandboxAccessServices } from "../src/sandbox-access-services.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const options: ControlOptions = {
  authStore: createMemoryAuthStore(),
  supabase: {
    supabaseUrl: "https://supabase.test",
    anonKey: "anon",
    fetch: async () => Response.json({ id: userId }),
  },
  store: {} as VaultStore,
  encryptionKey: undefined,
};
const encoder = new TextEncoder();

async function call(route: string, chunks: Uint8Array[] | null, endless = false) {
  let cancelled = false;
  let pulls = 0;
  const stream =
    chunks === null
      ? null
      : new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls++;
              const chunk = chunks.shift();
              if (chunk) controller.enqueue(chunk);
              else if (!endless) controller.close();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        );
  const response = await handleControlRequest(
    new Request(`https://armada.test/api/v1/${route}`, {
      method: "POST",
      headers: { authorization: "Bearer e30.e30.sig" },
      body: stream,
      duplex: "half",
    }),
    options,
  );
  expect(response).not.toBeNull();
  expect(stream?.locked ?? false).toBe(false);
  return { response: response!, cancelled, pulls };
}

test("control streams enforce separate byte caps and cancel without reading the remainder", async () => {
  for (const [route, cap, message] of [
    ["unknown", 128 * 1024, "The request is too large."],
    ["variables/list", 64 * 1024, "Invalid application vault request."],
  ] as const) {
    // Split a multibyte character across chunks; character count is below either cap.
    const bytes = encoder.encode(JSON.stringify({ value: "é".repeat(cap / 2) }));
    const result = await call(route, [bytes.slice(0, 12), bytes.slice(12), encoder.encode("never read")], true);
    expect(result.response.status).toBe(route === "unknown" ? 413 : 400);
    expect(await result.response.json()).toMatchObject({ error: { code: "invalid", message } });
    expect(result.cancelled).toBe(true);
    expect(result.pulls).toBe(2);
    const exact = encoder.encode(`{"v":"${"x".repeat(cap - 8)}"}`);
    expect(exact.byteLength).toBe(cap);
    const accepted = await call(route, [exact]);
    // Dispatch reached: unknown general route / unavailable application vault.
    expect(accepted.response.status).toBe(route === "unknown" ? 404 : 503);
  }
});

test("control JSON policies preserve empty, whitespace, object and malformed UTF-8 behavior", async () => {
  for (const route of ["unknown", "variables/list"]) {
    const vault = route.startsWith("variables/");
    for (const body of [null, "", " \n\t", "{", "[]", "null"]) {
      const result = await call(route, body === null ? null : [encoder.encode(body)]);
      const empty = body === null || body.trim() === "";
      expect(result.response.status).toBe(!vault && empty ? 404 : 400);
      if (vault)
        expect(await result.response.json()).toMatchObject({
          error: { message: "Invalid application vault request." },
        });
    }
    const malformed = new Uint8Array([...encoder.encode('{"v":"'), 0xff, ...encoder.encode('"}')]);
    const result = await call(route, [malformed]);
    expect(result.response.status).toBe(vault ? 400 : 404);
  }
});

test("every published route refuses a body over its published limit with its published status", async () => {
  const published = (await import("../openapi.json")).default as unknown as {
    paths: Record<
      string,
      { post?: { requestBody?: { "x-max-body-bytes"?: number; "x-oversized-body-status"?: number } } }
    >;
  };
  let authorizationLookups = 0;
  const sql: Sql = {
    async query() {
      authorizationLookups++;
      return { rows: [] };
    },
    transaction: (work) => work(sql),
  };
  const configuredOptions = {
    ...options,
    githubAccount: createGitHubAccountApi({
      sql,
      app: { clientId: "test", clientSecret: "test" },
      encryptionKey: Buffer.alloc(32).toString("base64"),
    }),
  };
  const { scopedToolsRoute } = createSandboxAccessServices({
    sql,
    providers: {
      resolve: async () => {
        throw new Error("Unexpected provider lookup");
      },
    },
    credentials: {
      resolve: async () => {
        throw new Error("Unexpected credential lookup");
      },
    },
    connections: undefined,
    encryptionKey: Buffer.alloc(32).toString("base64"),
    scopedMcpUrl: "https://armada.test/api/v1/orchestrator-tools/mcp",
  });
  const scopedBodies = {
    finish: {},
    launch: {
      selection: { goldenId: userId, harness: "codex", credentialId: userId, credentialVersion: 1, model: "test" },
    },
    read: { sandboxId: userId },
    message: { sandboxId: userId, text: "test" },
    stop: { sandboxId: userId },
    extend: { sandboxId: userId, ttlSeconds: 60 },
  };
  for (const [path, { post }] of Object.entries(published.paths)) {
    const requestBody = post?.requestBody;
    if (
      requestBody?.["x-max-body-bytes"] === undefined ||
      requestBody["x-oversized-body-status"] === 503 ||
      path === "/api/v1/logs/read"
    )
      continue;
    const route = path.slice("/api/v1/".length);
    const limit = requestBody["x-max-body-bytes"];
    const scopedMethod = path.startsWith(`${ORCHESTRATOR_SCOPED_PATH}/`)
      ? path.slice(ORCHESTRATOR_SCOPED_PATH.length + 1)
      : "";
    const scoped = isScopedMethod(scopedMethod);
    const body = scoped
      ? JSON.stringify(scopedBodies[scopedMethod]) + " ".repeat(limit)
      : route === "github/oauth/callback"
        ? JSON.stringify({ state: `armada_cli_${"0".repeat(72)}`, code: "test" }) + " ".repeat(limit)
        : JSON.stringify({ pad: "x".repeat(limit) });
    const request = new Request(`https://armada.test${path}`, {
      method: "POST",
      headers: {
        authorization: scoped ? `Bearer armada_epoch_${"0".repeat(64)}` : "Bearer e30.e30.sig",
        "content-type": "application/json",
        ...(scoped && { "idempotency-key": "body-limit" }),
      },
      body,
    });
    const response = (await scopedToolsRoute(request)) ?? (await handleControlRequest(request, configuredOptions));
    expect({ route, status: response?.status }).toEqual({ route, status: requestBody["x-oversized-body-status"] });
  }
  expect(authorizationLookups).toBe(0);
});
