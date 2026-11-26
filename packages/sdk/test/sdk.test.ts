import { expect, jest, test } from "bun:test";
import { inspect } from "node:util";
import type { DockerLaunchRequest, DockerSandboxStatus } from "@armada/core";
import { launch, parseLaunchAdmissionReceipt } from "@armada/core/contract";
import { ProviderError } from "@armada/core/server";
import { controlFailureResponse } from "../../mcp-server/src/control-errors.ts";
import { webhookSignature } from "../../mcp-server/src/outbound-webhooks.ts";
import { createRuntimeAgent } from "../../mcp-server/src/runtime-agent.ts";
import { RuntimeCommandPending, RuntimeCommandRefused } from "../../mcp-server/src/runtime-commands.ts";
import { createServerRequestDrain } from "../../mcp-server/src/server-request-drain.ts";
import { commandClient } from "../src/commands.ts";
import {
  Armada,
  ArmadaError,
  type DockerLaunchInput,
  type SandboxStatus,
  verifyWebhookSignature,
} from "../src/index.ts";

const dockerInputMatchesCore: [
  Exclude<keyof DockerLaunchRequest, keyof DockerLaunchInput>,
  Exclude<keyof DockerLaunchInput, keyof DockerLaunchRequest>,
] extends [never, never]
  ? true
  : never = true;
void dockerInputMatchesCore;
const dockerPrompt: SandboxStatus["prompt"] = null as DockerSandboxStatus["prompt"];
void dockerPrompt;

test("service-token methods use the REST routes and preserve wire field names", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const client = new Armada({
    token: "service_placeholder",
    fetch: (async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer service_placeholder");
      expect(init?.redirect).toBe("error");
      requests.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({ id: "sandbox_placeholder" });
    }) as import("../src/index.ts").Fetch,
  });
  await client.launch({ provider: "boat", golden: "worker", harness: "codex", ttlSeconds: 60 });
  await client.launchFromTemplate({
    org: "org_placeholder",
    id: "template_placeholder",
    requestKey: "request_placeholder",
  });
  await client.send({ id: "sandbox_placeholder", prompt: "Work", request_id: "request_placeholder" });
  await client.status({ id: "sandbox_placeholder", recorded: true });
  await client.wait({ id: "sandbox_placeholder", timeout_seconds: 0 });
  await client.logs({ id: "sandbox_placeholder", cursor: "cursor_placeholder" });
  await client.stop({ id: "sandbox_placeholder" });
  expect(requests.map((x) => x.path)).toEqual(
    [
      "sandbox/launch",
      "templates/launch",
      "sandbox/send",
      "sandbox/status",
      "sandbox/wait",
      "logs/read",
      "sandbox/stop",
    ].map((path) => `/api/v1/${path}`),
  );
  expect(requests[0]?.body).toEqual({ provider: "boat", golden: "worker", harness: "codex", ttlSeconds: 60 });
  expect(requests[2]?.body).toEqual({ id: "sandbox_placeholder", prompt: "Work", request_id: "request_placeholder" });
  expect(requests[5]?.body).toEqual({ id: "sandbox_placeholder", cursor: "cursor_placeholder" });
});

test("a logged or serialized client never exposes its service token, yet still authenticates", async () => {
  let authorization = null as string | null;
  const client = new Armada({
    token: "service_secret_placeholder",
    fetch: (async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ id: "sandbox_placeholder" });
    }) as import("../src/index.ts").Fetch,
  });
  for (const shown of [
    JSON.stringify(client),
    inspect(client, { depth: 10, showHidden: true }),
    String(Object.values(client)),
  ])
    expect(shown).not.toContain("service_secret_placeholder");
  await client.status({ id: "sandbox_placeholder" });
  expect(authorization).toBe("Bearer service_secret_placeholder");
});

test("launch sends a Docker request and returns its admission receipt", async () => {
  const org = "00000000-0000-4000-8000-000000000001";
  const input = {
    org,
    provider: "docker",
    hostId: "00000000-0000-4000-8000-000000000002",
    harness: "codex",
    idempotencyKey: "customer_launch_1",
    prompt: "Work",
    repos: [{ url: "https://github.com/acme/app", branch: "main" }],
  } satisfies DockerLaunchInput;
  expect(launch.input.body.safeParse(input).success).toBe(true);
  const history = { ...input, repos: [{ url: "https://github.com/acme/app", history: "full" }] };
  expect(launch.input.body.safeParse(history).success).toBe(false);
  const receipt = { sandbox: { id: "00000000-0000-4000-8000-000000000003", status: "starting" as const } };
  expect(parseLaunchAdmissionReceipt("docker", receipt)).toEqual(receipt);
  let sent: unknown;
  const client = new Armada({
    token: "service_placeholder",
    fetch: (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json(receipt);
    }) as import("../src/index.ts").Fetch,
  });
  const launched = await client.launch(input);
  expect(launched).toEqual(receipt);
  expect(sent).toEqual(input);
});

test("the SDK Docker launch type admits exactly the host and snapshot sources the server accepts", () => {
  const {
    hostId,
    repos: _repos,
    ...common
  } = {
    org: "00000000-0000-4000-8000-000000000001",
    provider: "docker",
    hostId: "00000000-0000-4000-8000-000000000002",
    harness: "codex",
    idempotencyKey: "customer_launch_1",
    repos: [{ url: "https://github.com/acme/app" }],
  } as const;
  const snapshotId = "00000000-0000-4000-8000-000000000004";
  const accepted: DockerLaunchInput[] = [
    { ...common, hostId },
    { ...common, hostId, repos: [{ url: "https://github.com/acme/app" }] },
    { ...common, snapshotId },
    { ...common, snapshotId, hostId },
  ];
  for (const body of accepted) expect(launch.input.body.safeParse(body).success).toBe(true);
  // @ts-expect-error A Docker launch needs a host or a snapshot.
  const noSource: DockerLaunchInput = { ...common };
  // @ts-expect-error A snapshot carries its own workspace, so repos are refused.
  const snapshotRepos: DockerLaunchInput = { ...common, snapshotId, repos: [{ url: "https://github.com/acme/app" }] };
  for (const body of [noSource, snapshotRepos]) expect(launch.input.body.safeParse(body).success).toBe(false);
});

test("status exposes the selected prompt by its promptId", async () => {
  const prompt: SandboxStatus["prompt"] = {
    promptId: "prompt_placeholder",
    conversationId: null,
    state: "queued",
    reason: null,
  };
  const client = new Armada({
    token: "service_placeholder",
    fetch: async () =>
      Response.json({
        id: "sandbox_placeholder",
        status: "running",
        settled: false,
        statusReason: null,
        prompt,
        conversationIds: [],
        expiresAt: null,
      }),
  });
  const status = await client.status({ id: "sandbox_placeholder", prompt_id: "prompt_placeholder" });
  const promptId: string | undefined = status.prompt?.promptId;
  expect(promptId).toBe("prompt_placeholder");
  expect(status.prompt).toEqual(prompt);
});

test("retry policy replays only eligible reads and retains typed safe failures", async () => {
  for (const operation of ["status", "stop"] as const) {
    let count = 0;
    const client = new Armada({
      token: "service_placeholder",
      readRetries: 2,
      fetch: (async () => {
        count++;
        return Response.json({ error: { code: "provider_unavailable", message: "secret_echo" } }, { status: 502 });
      }) as import("../src/index.ts").Fetch,
    });
    try {
      await client[operation]({ id: "sandbox_placeholder" });
      throw new Error("Expected error");
    } catch (error) {
      expect(error).toBeInstanceOf(ArmadaError);
      expect((error as ArmadaError).code).toBe("provider_unavailable");
      expect((error as ArmadaError).message).not.toContain("secret_echo");
      expect((error as ArmadaError).outcomeUnknown).toBe(operation === "stop");
    }
    expect(count).toBe(operation === "status" ? 3 : 1);
  }
  for (const code of [
    "rate_limited",
    "payment_required",
    "no_credentials",
    "credential_binding_required",
    "init_failed",
  ]) {
    const typed = new Armada({
      token: "service_placeholder",
      fetch: async () => Response.json({ error: { code } }, { status: 400 }),
    });
    await expect(typed.launch({ provider: "boat", golden: "worker", harness: "codex" })).rejects.toMatchObject({
      code,
      serverCode: code,
    });
  }

  for (const [serverCode, code] of [
    ["provider_mismatch", "provider_mismatch"],
    ["future_failure", "unknown_response"],
  ]) {
    const client = new Armada({
      token: "service_placeholder",
      fetch: async () => Response.json({ error: { code: serverCode, message: "secret_echo" } }, { status: 400 }),
    });
    const error = await client.logs({ id: "sandbox_placeholder" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArmadaError);
    expect(error).toMatchObject({ code, serverCode });
    expect((error as ArmadaError).message).not.toContain("secret_echo");
    if (code === "unknown_response") {
      expect((error as ArmadaError).message).toBe(
        "Armada request failed (unknown_response: future_failure, HTTP 400).",
      );
    }
  }
});

test("server-requested retry delays reach the caller and suppress early replays", async () => {
  const drain = createServerRequestDrain(async () => Response.json({}));
  drain.beginDrain();
  const failures = [
    { fetch: async (request: Request) => drain.fetch(request), retryAfterSeconds: 5 },
    {
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "rate_limited",
              message: "secret_echo",
              details: { provider: "boat", retryAfterSeconds: 120 },
            },
          },
          { status: 429 },
        ),
      retryAfterSeconds: 120,
    },
    {
      fetch: async () =>
        Response.json(
          { error: { code: "unavailable" } },
          { status: 503, headers: { "retry-after": new Date(Date.now() + 61_000).toUTCString() } },
        ),
      retryAfterSeconds: 61,
    },
  ];
  for (const failure of failures) {
    let count = 0;
    const client = new Armada({
      token: "service_placeholder",
      readRetries: 3,
      fetch: (async (url, init) => {
        count++;
        return failure.fetch(new Request(String(url), init));
      }) as import("../src/index.ts").Fetch,
    });
    const error = await client.status({ id: "sandbox_placeholder" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ArmadaError);
    expect((error as ArmadaError).retryAfterSeconds).toBeWithin(
      failure.retryAfterSeconds - 1,
      failure.retryAfterSeconds + 1,
    );
    expect(count).toBe(1);
  }
  const unscheduled = new Armada({
    token: "service_placeholder",
    fetch: async () =>
      Response.json({ error: { code: "unavailable" } }, { status: 503, headers: { "retry-after": "soon" } }),
  });
  await expect(unscheduled.status({ id: "sandbox_placeholder" })).rejects.toMatchObject({
    retryAfterSeconds: undefined,
  });
});

test("server retry delays longer than one day reach the caller unchanged", async () => {
  const delay = 172_800;
  const limited = controlFailureResponse(
    new ProviderError({
      provider: "boat",
      code: "rate_limited",
      status: 429,
      message: "secret_echo",
      retryable: true,
      retryAfterSeconds: delay,
      details: { window: "day" },
    }),
  );
  expect(limited.status).toBe(429);
  const body = await limited.text();
  const responses = [
    () => new Response(body, { status: 429, headers: limited.headers }),
    () => Response.json({ error: { code: "unavailable" } }, { status: 503, headers: { "retry-after": String(delay) } }),
    () =>
      Response.json(
        { error: { code: "unavailable" } },
        { status: 503, headers: { "retry-after": new Date(Date.now() + delay * 1000).toUTCString() } },
      ),
  ];
  for (const respond of responses) {
    const client = new Armada({ token: "service_placeholder", fetch: async () => respond() });
    const error = await client
      .launch({ provider: "boat", golden: "worker", harness: "codex" })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ArmadaError);
    expect((error as ArmadaError).retryAfterSeconds).toBeWithin(delay - 1, delay + 1);
  }
});

const outputSandboxId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";

function testControl<Input>(
  route: string,
  input: Input,
  receipt: object,
  call: (client: Armada, input: Input) => Promise<unknown>,
  readOnly = false,
) {
  test(`SDK POSTs the typed request and returns the receipt for ${route}`, async () => {
    let calls = 0;
    const client = new Armada({
      token: "service_placeholder",
      url: "https://direct.armada.test",
      readRetries: 1,
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe(`https://direct.armada.test/api/v1/${route}`);
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer service_placeholder");
        expect(JSON.parse(String(init?.body))).toEqual(input);
        return readOnly && calls === 1 ? new Response(null, { status: 502 }) : Response.json(receipt);
      },
    });
    expect(await call(client, input)).toEqual(receipt);
    expect(calls).toBe(readOnly ? 2 : 1);
  });
}

testControl(
  "sandbox/list",
  { page: 2, limit: 1, externalRef: "work-item", org: "00000000-0000-4000-8000-000000000003" },
  { sandboxes: [], total: 1, page: 2, limit: 1, hasMore: false, nextPage: null },
  (client, input) => client.list(input),
  true,
);
testControl(
  "sandbox/interrupt",
  { id: outputSandboxId, request_id: requestId },
  { id: outputSandboxId, interrupted: true },
  (client, input) => client.interrupt(input),
);
testControl(
  "sandbox/steer",
  { id: outputSandboxId, text: "Use the existing endpoint", request_id: requestId },
  { id: outputSandboxId, promptId: "prompt", conversationId: "conversation", delivery: "restart", mode: null },
  (client, input) => client.steer(input),
);
testControl(
  "sandbox/exec",
  { id: outputSandboxId, command: "pwd", cwd: "/home/user", timeout_seconds: 400, request_id: requestId },
  { id: outputSandboxId, exitCode: 1, stdout: "", stderr: "failed", timedOut: false, truncated: false },
  (client, input) => client.exec(input),
);
testControl(
  "sandbox/viewer-token",
  { id: outputSandboxId },
  { token: "viewer_placeholder", expiresAt: "2026-11-20T15:00:00Z" },
  (client, input) => client.createViewerToken(input),
);

test("viewer token denial preserves the server failure code", async () => {
  const client = new Armada({
    token: "service_placeholder",
    url: "https://direct.armada.test",
    fetch: async () => Response.json({ error: "viewer_access_denied" }, { status: 403 }),
  });
  await expect(client.createViewerToken({ id: outputSandboxId })).rejects.toMatchObject({
    code: "viewer_access_denied",
    status: 403,
    outcomeUnknown: false,
  });
});

test("viewer token minting requires an explicit direct server origin", async () => {
  const fetch = jest.fn(async () => new Response());
  const client = new Armada({ token: "service_placeholder", fetch });
  await expect(client.createViewerToken({ id: outputSandboxId })).rejects.toThrow("direct Armada server URL");
  expect(fetch).not.toHaveBeenCalled();
});

test("outputs.list uses the snapshot GET and forwards cancellation", async () => {
  const receipt = {
    directory: "/home/user/outputs",
    limits: { maxFiles: 32 as const, maxFileBytes: 33554432, maxSandboxBytes: 67108864, maxOrgBytes: 1073741824 },
    files: [{ name: "artifact.bin", size: 3, sha256: null, updatedAt: "2026-11-20T15:00:00Z" }],
  };
  const controller = new AbortController();
  const client = new Armada({
    token: "service_placeholder",
    fetch: async (url, init) => {
      expect(new URL(String(url)).pathname).toBe(`/api/v1/sandboxes/${outputSandboxId}/outputs`);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return Response.json(receipt);
    },
  });
  expect(await client.outputs.list({ id: outputSandboxId }, { signal: controller.signal })).toEqual(receipt);
});

test("outputs.get encodes the output name and preserves a streamed binary range and its headers", async () => {
  const bytes = Uint8Array.of(0, 255, 128);
  const client = new Armada({
    token: "service_placeholder",
    fetch: async (url, init) => {
      expect(new URL(String(url)).pathname).toBe(
        `/api/v1/sandboxes/${outputSandboxId}/outputs/r%C3%A9sum%C3%A9%20%23.bin`,
      );
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer service_placeholder");
      expect(headers.get("range")).toBe("bytes=0-2");
      expect(headers.get("if-range")).toBe('"artifact"');
      return new Response(bytes, {
        status: 206,
        headers: { "content-range": "bytes 0-2/5", etag: '"artifact"' },
      });
    },
  });
  const response = await client.outputs.get({
    id: outputSandboxId,
    name: "résumé #.bin",
    range: "bytes=0-2",
    ifRange: '"artifact"',
  });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 0-2/5");
  expect(response.headers.get("etag")).toBe('"artifact"');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
});

test("outputs.list and outputs.get wrap invalid sandbox IDs and output names as TypeError before sending a request", async () => {
  const fetch = jest.fn(async () => new Response());
  const client = new Armada({ token: "service_placeholder", fetch });
  for (const call of [
    () => client.outputs.list({ id: "not-a-uuid" }),
    () => client.outputs.get({ id: "not-a-uuid", name: "artifact.bin" }),
    () => client.outputs.get({ id: outputSandboxId, name: ".." }),
  ]) {
    const error = await call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).name).toBe("TypeError");
    expect((error as Error).message).not.toContain("invalid_format");
  }
  expect(fetch).not.toHaveBeenCalled();
});

test("outputs.get preserves the available length when a range is unsatisfiable", async () => {
  const client = new Armada({
    token: "service_placeholder",
    fetch: async () => new Response(null, { status: 416, headers: { "content-range": "bytes */5" } }),
  });
  const response = await client.outputs.get({ id: outputSandboxId, name: "artifact.bin", range: "bytes=8-" });
  expect(response.status).toBe(416);
  expect(response.headers.get("content-range")).toBe("bytes */5");
});

test("outputs.get maps a flat API error without exposing a success stream", async () => {
  const client = new Armada({
    token: "service_placeholder",
    fetch: async () => Response.json({ error: "not_found" }, { status: 404 }),
  });
  await expect(client.outputs.get({ id: outputSandboxId, name: "missing" })).rejects.toMatchObject({
    code: "not_found",
    status: 404,
    outcomeUnknown: false,
  });
});

test("webhook verification accepts the server signer and binds exact body, timestamp and delivery id and rejects stale signatures", async () => {
  const body = '{"status":"finished"}';
  const secret = "webhook_placeholder";
  const headers = new Headers({
    "Armada-Webhook-Timestamp": "1000",
    "Armada-Webhook-Id": "delivery_placeholder",
    "Armada-Webhook-Signature": webhookSignature(secret, "1000", "delivery_placeholder", body),
  });
  const input = { body, secret, headers, now: 1000000 };
  expect(await verifyWebhookSignature(input)).toBe(true);
  expect(await verifyWebhookSignature({ ...input, body: `${body} ` })).toBe(false);
  expect(await verifyWebhookSignature({ ...input, now: 1400000 })).toBe(false);
  headers.set("Armada-Webhook-Id", "different_delivery");
  expect(await verifyWebhookSignature(input)).toBe(false);
});

test("remote origins must use HTTPS so the service token never crosses the network in cleartext", async () => {
  const calls: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${String(url)} ${new Headers(init?.headers).get("authorization")}`);
    return Response.json({ id: "sandbox_placeholder" });
  }) as typeof globalThis.fetch;
  for (const url of [
    "http://armada.example",
    "http://10.0.0.5:8080",
    "http://localhost.example.com",
    "http://[::2]",
    "http://app.localhost",
  ])
    expect(() => new Armada({ token: "service_canary", url, fetch })).toThrow(
      "Use an HTTPS Armada origin; plain HTTP is only accepted for loopback hosts.",
    );
  expect(calls).toEqual([]);
  const allowed = [
    "https://armada.example",
    "http://localhost:3000",
    "http://LOCALHOST",
    "http://127.0.0.1:4000",
    "http://127.1",
    "http://2130706433",
    "http://[::1]:8080",
  ];
  for (const url of allowed)
    await new Armada({ token: "service_canary", url, fetch }).status({ id: "sandbox_placeholder" });
  expect(calls.map((call) => new URL(call.split(" ")[0]!).origin)).toEqual([
    "https://armada.example",
    "http://localhost:3000",
    "http://localhost",
    "http://127.0.0.1:4000",
    "http://127.0.0.1",
    "http://127.0.0.1",
    "http://[::1]:8080",
  ]);
  expect(calls.every((call) => call.endsWith(" Bearer service_canary"))).toBe(true);
});

test("the default transport calls fetch without the client as its receiver", async () => {
  const original = globalThis.fetch;
  const receivers: unknown[] = [];
  const nativeLike = function (this: unknown) {
    receivers.push(this);
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(Response.json({ id: "sandbox_placeholder" }));
  } as unknown as typeof fetch;
  globalThis.fetch = nativeLike;
  try {
    await new Armada({ token: "service_placeholder" }).status({ id: "sandbox_placeholder" });
    await new Armada({ token: "service_placeholder", fetch: nativeLike }).status({ id: "sandbox_placeholder" });
  } finally {
    globalThis.fetch = original;
  }
  expect(receivers).toHaveLength(2);
});

test("template launch exposes the HTTP 200 pre-admission refusal without a request receipt", async () => {
  const client = new Armada({
    token: "service_placeholder",
    fetch: (async () =>
      Response.json({
        state: "failed",
        reason: "conflict",
        message: "Golden has no snapshot.",
      })) as import("../src/index.ts").Fetch,
  });
  const result = await client.launchFromTemplate({
    org: "org_placeholder",
    id: "template_placeholder",
    requestKey: "request_placeholder",
  });
  if ("requestId" in result) throw new Error("Expected a refusal");
  expect(result).toEqual({ state: "failed", reason: "conflict", message: "Golden has no snapshot." });
});

test("a draining server's refusal is a typed, admitted-nothing failure carrying Retry-After", async () => {
  let count = 0;
  const client = new Armada({
    token: "service_placeholder",
    readRetries: 3,
    fetch: (async () => {
      count++;
      return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: { "retry-after": "5" } });
    }) as import("../src/index.ts").Fetch,
  });
  for (const call of [
    () => client.send({ id: "sandbox_placeholder", prompt: "Work" }),
    () => client.status({ id: "sandbox_placeholder" }),
  ]) {
    const error = await call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArmadaError);
    expect(error).toMatchObject({ code: "unavailable", status: 503, outcomeUnknown: false, retryAfterSeconds: 5 });
  }
  expect(count).toBe(2);
});

test("the SDK browser bundle reaches no Node builtin, server entry point or workspace package", async () => {
  const built = await Bun.build({ entrypoints: [`${import.meta.dir}/../src/index.ts`], target: "browser" });
  expect(built.success).toBe(true);
  const bundle = await built.outputs[0]!.text();
  expect(bundle).not.toMatch(/from\s*["'](node:|@armada\/)|require\(|supabase|postgres/i);
});

test("wait and exec preserve their server budgets when client timeoutMs is shorter, while per-call timeoutMs overrides", async () => {
  let signal: AbortSignal | null | undefined;
  const fetch: import("../src/index.ts").Fetch = async (_url, init) => {
    signal = init?.signal;
    return Response.json({ id: "sandbox_placeholder", timedOut: false });
  };
  const expectDeadline = (milliseconds: number) => {
    jest.advanceTimersByTime(milliseconds - 1);
    expect(signal?.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(signal?.reason).toMatchObject({ name: "TimeoutError" });
  };
  const shortClient = new Armada({ token: "service_placeholder", timeoutMs: 15_000, fetch });
  const longClient = new Armada({ token: "service_placeholder", timeoutMs: 600_000, fetch });
  const unconfigured = new Armada({ token: "service_placeholder", fetch });

  jest.useFakeTimers();
  try {
    await shortClient.status({ id: "sandbox_placeholder" });
    expectDeadline(15_000);
    await shortClient.wait({ id: "sandbox_placeholder" });
    expectDeadline(90_000);
    await shortClient.wait({ id: "sandbox_placeholder", timeout_seconds: 10 });
    expectDeadline(40_000);
    await shortClient.wait({ id: "sandbox_placeholder" }, { timeoutMs: 3_000 });
    expectDeadline(3_000);
    await shortClient.exec({ id: "sandbox_placeholder", command: "pwd" });
    expectDeadline(300_000);
    await shortClient.exec({ id: "sandbox_placeholder", command: "pwd", timeout_seconds: 400 });
    expectDeadline(430_000);
    await shortClient.exec({ id: "sandbox_placeholder", command: "pwd" }, { timeoutMs: 3_000 });
    expectDeadline(3_000);
    await longClient.wait({ id: "sandbox_placeholder", timeout_seconds: 10 });
    expectDeadline(600_000);
    await longClient.exec({ id: "sandbox_placeholder", command: "pwd", timeout_seconds: 400 });
    expectDeadline(600_000);
    await unconfigured.wait({ id: "sandbox_placeholder", timeout_seconds: 10 });
    expectDeadline(40_000);
    await unconfigured.status({ id: "sandbox_placeholder" });
    expectDeadline(300_000);
  } finally {
    jest.useRealTimers();
  }
});

test("commandClient.dockerHost sends application/json content-type with its JSON body", async () => {
  let sentContentType = null as string | null;
  let sentBody: unknown;
  let sentPath = "";
  const commands = commandClient(
    "https://direct.armada.test",
    {
      fetch: async (url, init) => {
        sentPath = new URL(String(url)).pathname;
        sentContentType = new Headers(init?.headers).get("content-type");
        sentBody = JSON.parse(String(init?.body));
        return Response.json({ hosts: [] });
      },
      timeoutMs: 10_000,
      token: () => "service_placeholder",
      invalidPath: (error) => {
        throw error;
      },
    },
    (result) => (result.kind === "response" ? result.payload : null),
  );
  await commands.dockerHost("list", { org: "org_placeholder" });
  expect(sentPath).toBe("/api/v1/docker/hosts/list");
  expect(sentContentType).toBe("application/json");
  expect(sentBody).toEqual({ org: "org_placeholder" });
});

test("a body that fails after the headers is a transport error, while a malformed body stays unknown_response", async () => {
  const partial = (signal?: AbortSignal | null) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"state":'));
        if (!signal) controller.error(new TypeError("connection reset"));
        else signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    });
  const client = (body: (init?: RequestInit) => ConstructorParameters<typeof Response>[0]) =>
    new Armada({
      token: "service_placeholder",
      readRetries: 3,
      fetch: (async (_url, init) =>
        new Response(body(init), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as import("../src/index.ts").Fetch,
    });
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: InstanceType<typeof ArmadaError>) => ({
        code: error.code,
        status: error.status,
        outcomeUnknown: error.outcomeUnknown,
      }),
    );
  const reset = client(() => partial());
  const abort = new AbortController();
  const stalled = client((init) => partial(init?.signal));
  const pendingWait = failure(stalled.wait({ id: "sandbox_placeholder" }, { signal: abort.signal }));
  abort.abort(new DOMException("deadline", "TimeoutError"));
  expect(await failure(reset.status({ id: "sandbox_placeholder" }))).toEqual({
    code: "transport_error",
    status: 0,
    outcomeUnknown: false,
  });
  expect(await pendingWait).toEqual({ code: "transport_error", status: 0, outcomeUnknown: false });
  expect(await failure(reset.stop({ id: "sandbox_placeholder" }))).toEqual({
    code: "transport_error",
    status: 0,
    outcomeUnknown: true,
  });
  expect(await failure(client(() => "{not json").status({ id: "sandbox_placeholder" }))).toEqual({
    code: "unknown_response",
    status: 200,
    outcomeUnknown: false,
  });
});

test("a failure status whose body breaks keeps its HTTP status and Retry-After", async () => {
  const client = new Armada({
    token: "service_placeholder",
    fetch: (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            controller.error(new TypeError("connection reset"));
          },
        }),
        { status: 503, headers: { "retry-after": "7" } },
      )) as import("../src/index.ts").Fetch,
  });
  const error = await client.stop({ id: "sandbox_placeholder" }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ArmadaError);
  expect(error).toMatchObject({ code: "unknown_response", status: 503, outcomeUnknown: true, retryAfterSeconds: 7 });
});

test("an exec admitted but still pending reaches the SDK as outcome unknown; a pre-admission refusal stays definite", async () => {
  const exec = async (lost: Error) => {
    const agent = createRuntimeAgent(
      {
        call: async () => {
          throw lost;
        },
      },
      {
        provider: "docker",
        harness: "codex",
        ownerId: "owner",
        sandboxId: "logical",
        providerSandboxId: "physical",
        cwd: "/home/user",
        defaults: { model: "gpt-5.4", reasoningEffort: "high" },
      },
    );
    let calls = 0;
    const client = new Armada({
      token: "service_placeholder",
      readRetries: 1,
      fetch: async (_url, init) => {
        calls++;
        const { command } = JSON.parse(String(init?.body)) as { command: string };
        return agent
          .exec({ sandboxId: "physical", command })
          .then((result) => Response.json(result))
          .catch(controlFailureResponse);
      },
    });
    const failure = await client.exec({ id: "logical", command: "pwd" }).catch((error: unknown) => error);
    expect(calls).toBe(1);
    return failure;
  };
  expect(await exec(new RuntimeCommandPending())).toMatchObject({
    code: "outcome_unknown",
    status: 503,
    outcomeUnknown: true,
  });
  expect(await exec(new RuntimeCommandRefused())).toMatchObject({
    code: "conflict",
    status: 409,
    outcomeUnknown: false,
  });
});
