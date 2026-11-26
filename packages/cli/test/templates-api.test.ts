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
    },
  );
  return { code, out, err, requests };
}

test("template commands use the API contracts for list, get and launch", async () => {
  const cases = [
    { args: ["get", id, "--revision", "1"], action: "get", body: { org, id, revision: 1 } },
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

test.each(["create", "publish", "delete"])("template %s is unknown, including with help", async (verb) => {
  for (const suffix of [[id], ["--help"]]) {
    const result = await invoke(["template", verb, ...suffix]);
    expect(result.code).toBe(2);
    expect(result.err).toContain(`unknown command 'template ${verb}'`);
    expect(result.out).toBe("");
    expect(result.requests).toHaveLength(0);
  }
});

test("template names resolve within the selected organization", async () => {
  const named = await invoke(["template", "get", "preset"]);
  expect(named.code).toBe(0);
  expect(await named.requests[1]?.json()).toEqual({ org, id });
});

test.each([
  { args: ["launch", id, "--request-key", "run-1", "--model", "other"] },
  { args: ["launch", id] },
  { args: ["get", "--help", "--unknown"] },
  { args: ["unknown", "--help"] },
])("template rejects invalid arguments before making a request (%j)", async ({ args }) => {
  const result = await invoke(["template", ...args]);
  expect(result.code).toBe(2);
  expect(result.requests).toHaveLength(0);
});

test("template failures use closed actionable diagnostics without echoing untrusted response text", async () => {
  for (const [message, expected] of [
    ["Template revision unavailable.", "choose an existing revision"],
    ["Template launch refused: reference_unavailable.", "reference"],
    ["Template launch refused: environment_unavailable.", "snapshot"],
    ["Template launch refused: connection_unavailable.", "connection"],
    ["Template launch refused: environment_binding_changed.", "provider binding changed"],
    ["Template launch refused: environment_snapshot_unavailable.", "Template snapshot is unavailable or retired"],
    ["Template launch refused: connection_version_changed.", "grant changed"],
    ["Template launch refused: model_account_unavailable.", "Add one in Models"],
    ["Template launch refused: model_account_ambiguous.", "Set a default"],
    ["Template launch refused: model_account_refused.", "expired, revoked, changed or incompatible"],
    ["Template launch refused: model_account_version_changed.", "account version changed"],
    ["Template launch refused: model_account_incompatible.", "incompatible"],
    ["Template launch refused: missing_credential.", "Add a model account"],
    ["Template launch refused: credential_refused.", "Reconnect the model account"],
    ["Template launch refused: credential_busy.", "choose another account"],
    ["Template launch refused: unauthorized.", "Sign in again"],
    ["Template launch refused: launch_unavailable.", "Check the snapshot or Docker host"],
    ["Template launch refused: allocation_or_start_unknown.", "a sandbox may have started"],
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
      expect(result.err).not.toContain("command_failed");
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

test("template help does not swallow a literal prompt value", async () => {
  const result = await invoke(["template", "launch", id, "--request-key", "literal_prompt", "--prompt", "-h"]);
  expect(result.code).toBe(0);
  expect(result.requests).toHaveLength(1);
  expect(await result.requests[0]?.json()).toMatchObject({ prompt: "-h" });
  expect((await invoke(["template", "launch", "--help"])).out).toContain("--keep-after-merge");
});
