import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_HEADER, type Driver, Journal, Runner } from "../src/index.ts";
import { type BoundModelConnection, testModelConnection } from "../src/model-connection-test.ts";

test.each(["codex", "bearer", "api-key"])("runtime sends one tiny native-wire request (%s)", async (mode) => {
  const key = randomUUID();
  const connection: BoundModelConnection =
    mode === "codex"
      ? {
          harness: "codex",
          endpoint: {
            version: 1,
            baseUrl: "https://example.com/api/projects/p/openai/v1/responses",
            apiVersion: "2025-04-01-preview",
          },
          apiKey: key,
        }
      : {
          harness: "claude",
          endpoint: {
            version: 1,
            baseUrl: "https://example.com/anthropic",
            auth: mode === "bearer" ? "bearer" : "api-key",
          },
          apiKey: key,
        };
  let calls = 0;
  const result = await testModelConnection(connection, "model", new AbortController().signal, async (url, init) => {
    calls++;
    expect(String(url)).toBe(
      mode === "codex"
        ? "https://example.com/api/projects/p/openai/v1/responses?api-version=2025-04-01-preview"
        : "https://example.com/anthropic/v1/messages",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get(mode === "api-key" ? "x-api-key" : "authorization")).toBe(
      mode === "api-key" ? key : `Bearer ${key}`,
    );
    expect(headers.get(mode === "api-key" ? "authorization" : "x-api-key")).toBeNull();
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual(
      mode === "codex"
        ? { model: "model", input: ".", max_output_tokens: 16, store: false }
        : { model: "model", max_tokens: 1, messages: [{ role: "user", content: "." }] },
    );
    return Response.json(
      mode === "codex"
        ? { id: "resp_test", object: "response", status: "incomplete" }
        : { id: "msg_test", type: "message", role: "assistant", content: [] },
    );
  });
  expect(result).toEqual({ ok: true, status: 200, error: null, code: null });
  expect(calls).toBe(1);
  expect(JSON.stringify(result)).not.toContain(key);
});

test("provider status/codes survive but key-echoing bodies and unknown diagnostics do not", async () => {
  const key = randomUUID();
  const connection: BoundModelConnection = {
    harness: "codex",
    endpoint: { version: 1, baseUrl: "https://example.com/v1" },
    apiKey: key,
  };
  for (const code of ["invalid_api_key", key]) {
    const result = await testModelConnection(connection, "model", new AbortController().signal, async () =>
      Response.json({ error: { code, message: key } }, { status: 401 }),
    );
    expect(result).toEqual({ ok: false, status: 401, error: "provider_rejected", code: code === key ? null : code });
    expect(JSON.stringify(result)).not.toContain(key);
  }
  for (const response of [new Response("not a model"), new Response("x".repeat(16385))]) {
    expect(
      (await testModelConnection(connection, "model", new AbortController().signal, async () => response)).error,
    ).toBe("invalid_response");
  }
  const controller = new AbortController();
  controller.abort();
  let abortedCalls = 0;
  expect(
    await testModelConnection(connection, "model", controller.signal, async () => {
      abortedCalls++;
      throw Error("must not send");
    }),
  ).toEqual({ ok: false, status: null, error: "connection_failed", code: null });
  expect(abortedCalls).toBe(0);
});

test("private test RPC is grant protected, refuses request destinations/builders and writes no receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-connection-test-"));
  const token = randomUUID();
  const journal = new Journal(join(root, "journal"), (text) => text.replaceAll(token, "[redacted]"));
  const driver: Driver = {
    start() {
      throw Error("unused");
    },
    async close() {},
  };
  const grant = { token, sandboxId: "sandbox", generation: "1", expiresAt: Date.now() + 60000 };
  let calls = 0;
  const execution = {
    testModelConnection: async () => {
      calls++;
      return { ok: true, status: 200, error: null, code: null };
    },
  };
  const runner = new Runner(
    journal,
    grant,
    { codex: driver, claude: driver },
    undefined,
    undefined,
    undefined,
    execution,
  );
  const request = (extra: object = {}, bearer: string = token) =>
    new Request("https://runner/v1", {
      method: "POST",
      headers: { [AUTH_HEADER]: bearer },
      body: JSON.stringify({
        version: 1,
        sandboxId: "sandbox",
        requestId: "probe",
        op: "testModelConnection",
        harness: "codex",
        model: "model",
        ...extra,
      }),
    });
  try {
    expect((await runner.handle(request({}, "wrong"))).status).toBe(401);
    expect((await runner.handle(request({ endpoint: "https://attacker.example" }))).status).toBe(409);
    expect(calls).toBe(0);
    const result = await (await runner.handle(request())).json();
    expect(result).toEqual({
      version: 1,
      requestId: "probe",
      result: { ok: true, status: 200, error: null, code: null },
    });
    expect(journal.db.query("select count(*) as n from requests").get()).toEqual({ n: 0 });
    const builder = new Runner(journal, grant, { codex: driver, claude: driver }, undefined, undefined, undefined, {
      ...execution,
      credentialFreeBuilder: true,
    });
    expect((await builder.handle(request())).status).toBe(409);
    expect(calls).toBe(1);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
