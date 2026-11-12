import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { productionAuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";

function setup() {
  const output: string[] = [];
  const requests: Request[] = [];
  const auth = productionAuthIo(
    { out: (text) => output.push(text), err: (text) => output.push(text) },
    { ARMADA_URL: "https://armada.example", ARMADA_TOKEN: randomUUID() },
  );
  auth.fetch = (async (input, init) => {
    requests.push(new Request(String(input), init));
    return Response.json({ account: { id: "account" } });
  }) as typeof fetch;
  return { auth, output, requests };
}

test.each(["stdin", "file"] as const)(
  "CLI creates normalized Codex endpoint accounts with a private %s key",
  async (source) => {
    const h = setup();
    const apiKey = randomUUID();
    const baseUrl = "https://resource.services.ai.azure.com/api/projects/project/openai/v1";
    const args = [
      "creds",
      "set",
      "openai",
      "--name",
      "Foundry",
      "--org",
      "Team",
      "--base-url",
      baseUrl + "/responses",
      "--api-version",
      "2025-04-01-preview",
    ];
    if (source === "file") args.push("--file", "private-input");
    expect(
      await run(
        args,
        { out: h.auth.out, err: h.auth.err },
        {
          auth: h.auth,
          readFile: async (path) => {
            expect(path).toBe("private-input");
            return apiKey + "\n";
          },
          readStdin: async () => {
            expect(source).toBe("stdin");
            return apiKey + "\n";
          },
        },
      ),
    ).toBe(0);
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0];
    if (!request) throw Error("missing request");
    expect(new URL(request.url).pathname).toBe("/api/v1/creds/accounts/set");
    expect(await request.json()).toEqual({
      scope: "org",
      org: "Team",
      kind: "openai",
      name: "Foundry",
      value: JSON.stringify({ endpoint: { version: 1, baseUrl, apiVersion: "2025-04-01-preview" }, apiKey }),
    });
    expect(h.output.join("")).not.toContain(apiKey);
    expect(h.output.join("")).toContain("Modal only");
    expect(h.output.join("")).toContain("Responses API");
  },
);

test.each(
  [
    ["set", "openai", "--api-version", "v1"],
    ["set", "claude-oauth", "--name", "Subscription", "--base-url", "https://example.com"],
    ["set", "openai", "--base-url", "https://example.com"],
    ["list", "--base-url", "https://example.com"],
    ["set", "openai", "--name", "Foundry", "--base-url", "https://user:password@example.com"],
    [
      "set",
      "openai",
      "--name",
      "Foundry",
      "--base-url",
      "https://example.com",
      "--base-url",
      "https://other.example.com",
    ],
  ].map((args) => ({ args })),
)("invalid endpoint command refuses before secret input/API: %j", async ({ args }) => {
  const h = setup();
  let reads = 0;
  expect(
    await run(
      ["creds", ...args],
      { out: h.auth.out, err: h.auth.err },
      {
        auth: h.auth,
        readFile: async () => {
          reads++;
          return "";
        },
        readStdin: async () => {
          reads++;
          return "";
        },
      },
    ),
  ).not.toBe(0);
  expect(reads).toBe(0);
  expect(h.requests).toHaveLength(0);
  expect(h.output.join("")).not.toContain("password");
});

test("CLI rotation preserves account revision and JSON output without requiring an API version", async () => {
  const h = setup();
  const apiKey = randomUUID();
  expect(
    await run(
      [
        "creds",
        "set",
        "openai",
        "--id",
        "account",
        "--expected-version",
        "3",
        "--base-url",
        "https://example.com/v1",
        "--json",
      ],
      { out: h.auth.out, err: h.auth.err },
      { auth: h.auth, readStdin: async () => apiKey },
    ),
  ).toBe(0);
  const request = h.requests[0];
  if (!request) throw Error("missing request");
  expect(await request.json()).toEqual({
    scope: "user",
    kind: "openai",
    id: "account",
    expectedVersion: 3,
    value: JSON.stringify({ endpoint: { version: 1, baseUrl: "https://example.com/v1" }, apiKey }),
  });
  expect(h.output.join("")).toBe('{"ok":true}\n');
});

test("CLI refuses connection JSON when endpoint options require a raw key", async () => {
  const h = setup();
  expect(
    await run(
      ["creds", "set", "openai", "--name", "Foundry", "--base-url", "https://example.com/v1"],
      { out: h.auth.out, err: h.auth.err },
      { auth: h.auth, readStdin: async () => JSON.stringify({ apiKey: randomUUID() }) },
    ),
  ).not.toBe(0);
  expect(h.requests).toHaveLength(0);
  expect(h.output.join("")).toContain("supply only the API key");
});

test.each([
  { authMode: undefined, source: "stdin" },
  { authMode: "bearer", source: "file" },
  { authMode: "api-key", source: "stdin" },
])("CLI creates a Claude gateway with private input: %j", async ({ authMode, source }) => {
  const h = setup();
  const apiKey = randomUUID();
  const args = [
    "creds",
    "set",
    "anthropic",
    "--name",
    "Gateway",
    "--base-url",
    "https://gateway.example.com/anthropic/",
  ];
  if (authMode) args.push("--endpoint-auth", authMode);
  if (source === "file") args.push("--file", "private-key");
  expect(
    await run(
      args,
      { out: h.auth.out, err: h.auth.err },
      {
        auth: h.auth,
        readFile: async (path) => {
          expect(path).toBe("private-key");
          return apiKey;
        },
        readStdin: async () => {
          expect(source).toBe("stdin");
          return apiKey;
        },
      },
    ),
  ).toBe(0);
  expect(h.requests).toHaveLength(1);
  const request = h.requests[0];
  if (!request) throw Error("missing request");
  expect(new URL(request.url).pathname).toBe("/api/v1/creds/accounts/set");
  expect(await request.json()).toEqual({
    scope: "user",
    kind: "anthropic",
    name: "Gateway",
    value: JSON.stringify({
      endpoint: { version: 1, baseUrl: "https://gateway.example.com/anthropic", auth: authMode ?? "bearer" },
      apiKey,
    }),
  });
  expect(h.output.join("")).not.toContain(apiKey);
  expect(h.output.join("")).toContain("supports Claude models only");
});

test.each(
  [
    ["set", "anthropic", "--name", "Gateway", "--endpoint-auth", "bearer"],
    ["set", "openai", "--name", "Foundry", "--base-url", "https://example.com", "--endpoint-auth", "bearer"],
    ["set", "anthropic", "--name", "Gateway", "--base-url", "https://example.com", "--api-version", "v1"],
    ["set", "anthropic", "--name", "Gateway", "--base-url", "https://example.com", "--endpoint-auth", "oauth"],
    ["list", "--endpoint-auth", "bearer"],
  ].map((args) => ({ args })),
)("invalid gateway options refuse before reading a key or calling API: %j", async ({ args }) => {
  const h = setup();
  let reads = 0;
  expect(
    await run(
      ["creds", ...args],
      { out: h.auth.out, err: h.auth.err },
      {
        auth: h.auth,
        readStdin: async () => {
          reads++;
          return randomUUID();
        },
      },
    ),
  ).not.toBe(0);
  expect(reads).toBe(0);
  expect(h.requests).toHaveLength(0);
});

test.each([
  { result: { ok: true, status: 200, error: null, code: null }, exit: 0, message: "Connection accepted" },
  {
    result: { ok: false, status: 200, error: "invalid_response", code: null },
    exit: 1,
    message: "HTTP 200 invalid_response",
  },
  {
    result: { ok: false, status: null, error: "connection_failed", code: null },
    exit: 1,
    message: "connection failed or timed out",
  },
])(
  "connection test CLI prints closed diagnostics and reflects failure in exit status (%j)",
  async ({ result, exit, message }) => {
    const h = setup();
    h.auth.fetch = (async (input, init) => {
      const request = new Request(String(input), init);
      expect(new URL(request.url).pathname).toBe("/api/v1/sandbox/test-model-connection");
      expect(await request.json()).toEqual({ id: "sandbox", model: "deployment" });
      return Response.json({ id: "sandbox", test: result });
    }) as typeof fetch;
    expect(
      await run(
        ["creds", "test", "sandbox", "--model", "deployment"],
        { out: h.auth.out, err: h.auth.err },
        { auth: h.auth },
      ),
    ).toBe(exit);
    expect(h.output.join("")).toContain(message);
  },
);

test("connection test CLI refuses malformed diagnostic fields rather than echoing them", async () => {
  const h = setup();
  const secret = randomUUID();
  h.auth.fetch = (async () =>
    Response.json({
      test: { ok: false, status: 401, error: "provider_rejected", code: secret },
    })) as unknown as typeof fetch;
  expect(
    await run(
      ["creds", "test", "sandbox", "--model", "deployment", "--json"],
      { out: h.auth.out, err: h.auth.err },
      { auth: h.auth },
    ),
  ).not.toBe(0);
  expect(h.output.join("")).not.toContain(secret);
});

test.each(["openai", "anthropic"])("CLI stores exact per-model prices on a %s connection replacement", async (kind) => {
  const h = setup();
  const apiKey = randomUUID();
  expect(
    await run(
      [
        "creds",
        "set",
        kind,
        "--id",
        "account",
        "--expected-version",
        "3",
        "--base-url",
        "https://gateway.example/v1",
        "--price-model",
        "owner-deployment",
        "--price-input",
        "0",
        "--price-output",
        "12.345678901234",
        "--price-cached-input",
        "0.25",
        "--json",
      ],
      { out: h.auth.out, err: h.auth.err },
      { auth: h.auth, readStdin: async () => apiKey },
    ),
  ).toBe(0);
  const request = h.requests[0];
  if (!request) throw Error("missing request");
  const body = (await request.json()) as { id: string; expectedVersion: number; value: string };
  expect(body.id).toBe("account");
  expect(body.expectedVersion).toBe(3);
  const value = JSON.parse(body.value);
  expect(value.prices).toEqual({
    "owner-deployment": { input: "0", output: "12.345678901234", cacheRead: "0.25", cacheWrite: null, reasoning: null },
  });
  expect(value.apiKey).toBe(apiKey);
  expect(h.output.join("")).toBe('{"ok":true}\n');
});

test.each(
  [
    ["list", "--price-model", "deployment"],
    ["set", "openai", "--name", "Price", "--price-model", "deployment", "--price-input", "1", "--price-output", "2"],
    ...[
      ["--price-model", "deployment"],
      ["--price-model", "deployment", "--price-input", "-1", "--price-output", "2"],
      ["--price-model", "deployment", "--price-input", "1", "--price-output", "NaN"],
      ["--price-model", "deployment", "--price-input", "1e3", "--price-output", "2"],
      ["--price-model", "deployment", "--price-input", "1", "--price-output", "2", "--price-cached-input", ""],
      ["--price-model", "__proto__", "--price-input", "1", "--price-output", "2"],
      ["--price-model", "deployment", "--price-model", "other", "--price-input", "1", "--price-output", "2"],
    ].map((flags) => ["set", "openai", "--name", "Price", "--base-url", "https://gateway.example/v1", ...flags]),
  ].map((args) => ({ args })),
)("invalid prices are refused before secret input/API: %j", async ({ args }) => {
  const h = setup();
  let reads = 0;
  expect(
    await run(
      ["creds", ...args],
      { out: h.auth.out, err: h.auth.err },
      {
        auth: h.auth,
        readStdin: async () => {
          reads++;
          return randomUUID();
        },
      },
    ),
  ).not.toBe(0);
  expect(reads).toBe(0);
  expect(h.requests).toHaveLength(0);
});
