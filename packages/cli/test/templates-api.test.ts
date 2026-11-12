import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const org = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const golden = "33333333-3333-4333-8333-333333333333";
const definition = { goldenId: golden, provider: "boat", harness: "codex" };
const template = { id, orgId: org, name: "preset", scope: "personal", currentRevision: 2, status: "active" };

async function invoke(
  args: string[],
  options: {
    response?: unknown;
    status?: number;
    file?: string;
    fetchError?: Error;
    unreadableReply?: boolean;
    beforeLaunch?: (stderr: string) => void;
  } = {},
) {
  const requests: Request[] = [];
  let out = "",
    err = "";
  const code = await run(
    args,
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
    },
    {
      auth: {
        out: (s) => {
          out += s;
        },
        err: (s) => {
          err += s;
        },
        env: { ARMADA_TOKEN: "fixture-bearer", ARMADA_URL: "https://dashboard.invalid" },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        preferences: { read: async () => org, write: async () => {} },
        fetch: async (input, init) => {
          const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
          requests.push(request);
          if (request.url.endsWith("/templates/launch")) options.beforeLaunch?.(err);
          if (options.fetchError) throw options.fetchError;
          if (options.unreadableReply) return new Response("{truncated");
          if (request.url.endsWith("/templates/list")) return Response.json({ items: [template] });
          return Response.json(options.response ?? { item: template, revision: { revision: 1, definition } }, {
            status: options.status ?? 200,
          });
        },
      },
      readFile: async () => options.file ?? JSON.stringify(definition),
    },
  );
  return { code, out, err, requests };
}

// Contract owner: CLI argv -> authenticated API body, including public-origin route admission.
// A renamed route, dropped revision/key/override or leaked provider API would fail here.
test("template commands use the API contracts for all six dashboard-proxied operations", async () => {
  const cases = [
    {
      args: ["create", "preset", "--file", "definition.json"],
      action: "create",
      body: { org, scope: "personal", name: "preset", definition },
    },
    { args: ["get", id, "--revision", "1"], action: "get", body: { org, id, revision: 1 } },
    {
      args: ["publish", id, "--expected-revision", "2", "--file", "definition.json"],
      action: "publish",
      body: { org, id, expectedRevision: 2, definition },
    },
    { args: ["delete", id, "--expected-revision", "2"], action: "delete", body: { org, id, expectedRevision: 2 } },
    {
      args: [
        "launch",
        id,
        "--request-key",
        "run-1",
        "--revision",
        "1",
        "--prompt",
        "inspect",
        "--ttl",
        "30m",
        "--size",
        "small",
        "--repo",
        "repo",
      ],
      action: "launch",
      body: {
        org,
        id,
        requestKey: "run-1",
        revision: 1,
        prompt: "inspect",
        ttlSeconds: 1800,
        size: "small",
        repo: "repo",
      },
    },
    { args: ["list"], action: "list", body: { org } },
  ];
  for (const entry of cases) {
    const result = await invoke(["template", ...entry.args, "--json"]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.requests).toHaveLength(1);
    const request = result.requests[0];
    if (!request) throw new Error("Expected API request");
    expect(request.url).toBe(`https://dashboard.invalid/api/v1/templates/${entry.action}`);
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-bearer");
    expect(await request.clone().json()).toEqual(entry.body);
  }
});

test("template names resolve within the selected organization and flags create a definition", async () => {
  const named = await invoke(["template", "get", "preset"]);
  expect(named.code).toBe(0);
  expect(await named.requests[1]?.json()).toEqual({ org, id });
  const created = await invoke([
    "template",
    "create",
    "preset",
    "--golden",
    golden,
    "--provider",
    "boat",
    "--agent",
    "codex",
    "--org",
    org,
    "--scope",
    "org",
  ]);
  expect(created.code).toBe(0);
  expect(await created.requests[0]?.json()).toEqual({
    org,
    scope: "org",
    name: "preset",
    definition: { ...definition, connections: [], variables: [], skills: [] },
  });
});

test("template CLI refuses ambiguous scope, invalid revisions, unsupported overrides and inline secret values before mutation", async () => {
  for (const args of [
    ["create", "preset", "--org", org, "--file", "definition.json"],
    ["publish", id, "--expected-revision", "0", "--file", "definition.json"],
    ["launch", id, "--request-key", "run-1", "--model", "other"],
    ["launch", id],
  ]) {
    const result = await invoke(["template", ...args]);
    expect(result.code).not.toBe(0);
    expect(result.requests).toHaveLength(0);
  }
  const secret = await invoke(["template", "create", "preset", "--file", "definition.json"], {
    file: JSON.stringify({ ...definition, secrets: [{ key: "APP_TOKEN", value: true }] }),
  });
  expect(secret.code).not.toBe(0);
  expect(secret.requests).toHaveLength(0);
});

test("template failures use closed actionable diagnostics without echoing untrusted response text", async () => {
  for (const [message, expected] of [
    ["Template revision changed.", "revision"],
    ["Template launch refused: reference_unavailable.", "reference"],
    ["Template launch refused: environment_unavailable.", "golden"],
    ["Template launch refused: connection_unavailable.", "connection"],
    ["Template launch refused: environment_binding_changed.", "provider binding changed"],
    ["Template launch refused: environment_snapshot_unavailable.", "snapshot"],
    ["Template launch refused: connection_version_changed.", "grant changed"],
    ["Template launch refused: model_account_unavailable.", "Add one in Build > Harness"],
    ["Template launch refused: model_account_ambiguous.", "Set a default"],
    ["Template launch refused: model_account_refused.", "expired, revoked, changed or incompatible"],
    ["Template launch refused: model_account_version_changed.", "account version changed"],
    ["Template launch refused: model_account_incompatible.", "incompatible"],
    ["untrusted provider text: do-not-echo", "Template"],
  ] as const) {
    const result = await invoke(["template", "launch", id, "--request-key", "run-1"], {
      response: { error: { code: "conflict", message } },
      status: 409,
    });
    expect(result.code).not.toBe(0);
    expect(result.err).toContain(expected);
    expect(result.err).not.toContain("do-not-echo");
  }
});

test("template help documents definition inputs, scope and safe retry semantics without authentication", async () => {
  const result = await invoke(["template", "--help"]);
  expect(result.code).toBe(0);
  expect(result.requests).toHaveLength(0);
  for (const text of [
    "--file",
    "--scope",
    "--expected-revision",
    "--request-key",
    "--prompt",
    "--ttl",
    "--size",
    "--repo",
  ])
    expect(result.out).toContain(text);
});

// A name can disappear after admission, but the canonical ID must still reach durable replay.
test("name-based launch prints recovery ID before submission and ID retries bypass mutable name lookup", async () => {
  const args = [
    "--request-key",
    "durable-1",
    "--revision",
    "2",
    "--prompt",
    "inspect",
    "--ttl",
    "30m",
    "--size",
    "small",
    "--repo",
    "repo",
    "--json",
  ];
  const receipt = { state: "reconciling", requestId: "request", id: "sandbox" };
  const first = await invoke(["template", "launch", "preset", ...args], {
    response: receipt,
    beforeLaunch: (stderr) => {
      expect(stderr).toContain(id);
      expect(stderr).toContain("recovery");
    },
  });
  expect(first.code).toBe(1);
  expect(JSON.parse(first.out)).toEqual(receipt);
  expect(first.err).toContain("not confirmed");
  const retry = await invoke(["template", "launch", id, ...args], { response: { ...receipt, state: "succeeded" } });
  expect(retry.code).toBe(0);
  expect(retry.requests).toHaveLength(1);
  expect(await retry.requests[0]?.json()).toEqual(await first.requests[1]?.json());
});

test("template launch transport failures warn of unknown outcome and preserve idempotent recovery", async () => {
  for (const options of [
    { fetchError: new Error("private transport failure") },
    { fetchError: new DOMException("private timeout", "TimeoutError") },
    { unreadableReply: true },
  ]) {
    const result = await invoke(["template", "launch", id, "--request-key", "durable-1"], options);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("outcome unknown");
    expect(result.err).toContain("same template ID, request key and body");
    expect(result.err).not.toContain("private");
    expect(result.requests).toHaveLength(1);
  }
});

test("post-claim launch receipts distinguish confirmed refusal from uncertain allocation and translate closed reasons", async () => {
  for (const state of ["failed", "reconciling"]) {
    for (const [reason, help] of [
      ["environment_admission_unavailable", "golden became unavailable"],
      ["authorization_changed", "authorization changed"],
      ["variable_delivery_unavailable", "variable delivery is unavailable"],
      ["connection_unavailable", "connection is unknown"],
      ["private unknown reason", "Check current access"],
    ]) {
      const result = await invoke(["template", "launch", id, "--request-key", "durable-1", "--json"], {
        response: {
          state,
          reason,
          ...(reason === "connection_unavailable" ? { message: "Reconnect this tool before retrying." } : {}),
        },
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        reason === "connection_unavailable" ? "Reconnect this tool before retrying." : (help ?? ""),
      );
      expect(result.err).not.toContain("private unknown reason");
      if (state === "failed") {
        expect(result.err).toContain("no sandbox started");
        expect(result.err).not.toContain("outcome unknown");
      } else {
        expect(result.err).toContain("outcome unknown");
        expect(result.err).toContain("same template ID, request key and body");
      }
      expect(JSON.parse(result.out)).toMatchObject({ state, reason });
    }
  }
});

test("template get prints readable header and selected revision unless JSON is requested", async () => {
  const plain = await invoke(["template", "get", id, "--revision", "1"]);
  expect(plain.code).toBe(0);
  expect(plain.out).toContain("preset  personal");
  expect(plain.out).toContain("Selected revision: 1");
  expect(plain.out).not.toContain('"item"');
  const json = await invoke(["template", "get", id, "--revision", "1", "--json"]);
  expect(JSON.parse(json.out)).toEqual({ item: template, revision: { revision: 1, definition } });
});

test("template CLI sends secret references through repeatable flags and definition files", async () => {
  const binding = { key: "APP_TOKEN", secretId: id, version: 1 };
  for (const args of [
    ["--file", "definition.json"],
    ["--golden", id, "--provider", "boat", "--agent", "codex", "--secret", `APP_TOKEN:${id}:1`],
  ]) {
    const result = await invoke(["template", "create", "secret-preset", ...args], {
      file: JSON.stringify({ ...definition, secrets: [binding] }),
    });
    expect(result.code).toBe(0);
    expect(((await result.requests.at(-1)!.json()) as { definition: unknown }).definition).toMatchObject({
      secrets: [binding],
    });
  }
});
