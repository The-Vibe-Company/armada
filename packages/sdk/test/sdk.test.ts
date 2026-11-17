import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServerRequestDrain } from "../../mcp-server/src/server-request-drain.ts";
import { Armada, ArmadaError, verifyWebhookSignature } from "../src/index.ts";

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

test("webhook verification binds exact body, timestamp and delivery id and rejects stale signatures", async () => {
  const body = '{"status":"finished"}';
  const secret = "webhook_placeholder";
  const headers = new Headers({
    "Armada-Webhook-Timestamp": "1000",
    "Armada-Webhook-Id": "delivery_placeholder",
    "Armada-Webhook-Signature": `v1=${createHmac("sha256", secret).update(`1000.delivery_placeholder.${body}`).digest("hex")}`,
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
