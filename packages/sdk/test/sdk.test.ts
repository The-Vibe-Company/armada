import { expect, test } from "bun:test";
import type { DockerLaunchRequest, DockerSandboxStatus } from "@armada/core";
import { DOCKER_LAUNCH_REQUEST } from "../../mcp-server/src/docker-launch-request-schema.ts";
import { REST_LAUNCH_RESPONSE } from "../../mcp-server/src/launch-response-schemas.ts";
import { webhookSignature } from "../../mcp-server/src/outbound-webhooks.ts";
import { createServerRequestDrain } from "../../mcp-server/src/server-request-drain.ts";
import {
  Armada,
  ArmadaError,
  type DockerLaunchInput,
  type SandboxStatus,
  verifyWebhookSignature,
} from "../src/index.ts";

/** The SDK Docker launch input has exactly the fields of the server's Docker launch request. */
const dockerInputMatchesCore: [
  Exclude<keyof DockerLaunchRequest, keyof DockerLaunchInput>,
  Exclude<keyof DockerLaunchInput, keyof DockerLaunchRequest>,
] extends [never, never]
  ? true
  : never = true;
void dockerInputMatchesCore;
/** The server's status prompt (including a queued Docker prompt) is assignable to the SDK's. */
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
  await client.launch({ golden: "worker", harness: "codex", ttlSeconds: 60 });
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
  expect(requests[0]?.body).toEqual({ golden: "worker", harness: "codex", ttlSeconds: 60 });
  expect(requests[2]?.body).toEqual({ id: "sandbox_placeholder", prompt: "Work", request_id: "request_placeholder" });
  expect(requests[5]?.body).toEqual({ id: "sandbox_placeholder", cursor: "cursor_placeholder" });
});

test("launch sends a Docker request and returns the Docker receipt without a golden", async () => {
  const org = "00000000-0000-4000-8000-000000000001";
  const input = {
    org,
    provider: "docker",
    hostId: "00000000-0000-4000-8000-000000000002",
    harness: "codex",
    requestId: "00000000-0000-4000-8000-000000000003",
    prompt: "Work",
    repos: [{ url: "https://github.com/acme/app", branch: "main" }],
  } satisfies DockerLaunchInput;
  expect(DOCKER_LAUNCH_REQUEST.safeParse(input).success).toBe(true);
  // Docker checkouts are always shallow, so the published contract does not offer golden-config history.
  const history = { ...input, repos: [{ url: "https://github.com/acme/app", history: "full" }] };
  expect(DOCKER_LAUNCH_REQUEST.safeParse(history).success).toBe(false);
  const receipt = {
    sandbox: {
      id: "sandbox_placeholder",
      provider: "docker",
      providerSandboxId: "c1",
      status: "running",
      hostId: input.hostId,
    },
    golden: null,
    helper: null,
    github: { status: "none" },
    runtime: null,
    ttlSeconds: 3600,
    expiresAt: "2026-11-18T00:00:00.000Z",
  };
  expect(REST_LAUNCH_RESPONSE.safeParse(receipt).success).toBe(true);
  let sent: unknown;
  const client = new Armada({
    token: "service_placeholder",
    fetch: (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json(receipt);
    }) as import("../src/index.ts").Fetch,
  });
  const launched = await client.launch(input);
  const golden: null = launched.golden;
  expect(golden).toBeNull();
  expect(launched.sandbox.hostId).toBe(input.hostId);
  expect(launched.promptId).toBeUndefined();
  expect(sent).toEqual(input);
});

test("status exposes the selected prompt by its promptId", async () => {
  const prompt = { promptId: "prompt_placeholder", conversationId: null, state: "queued", reason: null };
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
    await expect(typed.launch({ golden: "worker", harness: "codex" })).rejects.toMatchObject({
      code,
      serverCode: code,
    });
  }
});

test("server-requested retry delays reach the caller and suppress early replays", async () => {
  // The real drain handler: 503 with Retry-After while the server shuts down.
  const drain = createServerRequestDrain(async () => Response.json({}));
  drain.beginDrain();
  const failures = [
    { fetch: async (request: Request) => drain.fetch(request), retryAfterSeconds: 5 },
    // The public provider rate-limit failure carries its delay in details, without a header.
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
    // HTTP dates round to whole seconds, so the delay is within one second of the date.
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

test("file helpers quote paths and reject truncated exec receipts", async () => {
  const commands: string[] = [];
  let truncated = false;
  const client = new Armada({
    token: "service_placeholder",
    fetch: (async (_url, init) => {
      commands.push(JSON.parse(String(init?.body)).command);
      return Response.json({
        id: "sandbox_placeholder",
        stdout: "hello",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated,
      });
    }) as import("../src/index.ts").Fetch,
  });
  expect(await client.files.read({ id: "sandbox_placeholder", path: "a'$(touch nope)" })).toBe("hello");
  expect(commands[0]).toBe(`cat < 'a'"'"'$(touch nope)'`);
  await client.files.write({ id: "sandbox_placeholder", path: "file", content: "hello" });
  expect(commands[1]).toBe("printf '%s' 'aGVsbG8=' | base64 -d > 'file'");
  truncated = true;
  await expect(client.files.read({ id: "sandbox_placeholder", path: "file" })).rejects.toBeInstanceOf(ArmadaError);
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

test("the default transport calls fetch without the client as its receiver", async () => {
  const original = globalThis.fetch;
  const receivers: unknown[] = [];
  // Mirrors browsers' native fetch, which throws "Illegal invocation" for any other receiver.
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
  // @ts-expect-error A refusal has no durable request; callers must narrow first.
  expect(() => result.requestId.toUpperCase()).toThrow(TypeError);
  if (result.requestId !== undefined) throw new Error("Expected a refusal");
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
  // The caller owns the delay that Retry-After asks for: no immediate replay.
  expect(count).toBe(2);
});

test("the SDK browser bundle reaches no Node builtin, server entry point or workspace package", async () => {
  const built = await Bun.build({ entrypoints: [`${import.meta.dir}/../src/index.ts`], target: "browser" });
  expect(built.success).toBe(true);
  const bundle = await built.outputs[0]!.text();
  expect(bundle).not.toMatch(/from\s*["'](node:|@armada\/)|require\(|supabase|postgres/i);
});

test("wait uses the per-call deadline, then the client deadline, then the server wait plus a margin", async () => {
  const deadlines: number[] = [];
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds: number) => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  };
  try {
    const fetch = (async () =>
      Response.json({ id: "sandbox_placeholder", timedOut: false })) as import("../src/index.ts").Fetch;
    const configured = new Armada({ token: "service_placeholder", timeoutMs: 2000, fetch });
    const unconfigured = new Armada({ token: "service_placeholder", fetch });
    await configured.status({ id: "sandbox_placeholder" });
    await configured.wait({ id: "sandbox_placeholder" });
    await configured.wait({ id: "sandbox_placeholder" }, { timeoutMs: 3000 });
    await unconfigured.wait({ id: "sandbox_placeholder", timeout_seconds: 10 });
    await unconfigured.status({ id: "sandbox_placeholder" });
    expect(deadlines).toEqual([2000, 2000, 3000, 40_000, 300_000]);
  } finally {
    AbortSignal.timeout = timeout;
  }
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
