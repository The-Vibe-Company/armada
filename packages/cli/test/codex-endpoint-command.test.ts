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
