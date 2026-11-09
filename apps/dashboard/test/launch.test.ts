import { expect, test } from "bun:test";
import { ControlError } from "../src/lib/control.ts";
import { launchSandbox } from "../src/lib/launch.ts";

const args = {
  golden: "web",
  provider: "boat" as const,
  org: "11111111-1111-4111-8111-111111111111",
  harness: "claude" as const,
  model: "claude-opus-5-5",
  reasoning_effort: "medium",
  visibility: "org" as const,
  connections: [],
};
const answering = (body: unknown, status = 200, seen: unknown[] = []) => ({
  serverUrl: "https://armada.test/mcp",
  token: "t",
  fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)));
    return Response.json(body, { status });
  }) as typeof fetch,
});

test("a size is sent only when chosen, and confirmed only by the server's recorded request", async () => {
  const seen: Record<string, unknown>[] = [];
  const recorded = {
    id: "s1",
    machineSize: { version: 1, requested: "large", effective: "large", source: "override" },
  };
  expect(await launchSandbox(answering({ sandbox: recorded }, 200, seen), { ...args, size: "large" })).toEqual({
    id: "s1",
    sizeConfirmed: true,
  });
  expect(seen[0]).toMatchObject({ size: "large" });
  // A server before #653 ignores `size`: the sandbox exists, but the size is not confirmed.
  expect(await launchSandbox(answering({ sandbox: { id: "s2" } }), { ...args, size: "large" })).toEqual({
    id: "s2",
    sizeConfirmed: false,
  });
  expect(await launchSandbox(answering({ sandbox: { id: "s3" } }, 200, seen), args)).toEqual({
    id: "s3",
    sizeConfirmed: true,
  });
  expect(seen[1]).not.toHaveProperty("size");
});

test("a provider refusal keeps the server's code, whatever its status", async () => {
  const refusal = { error: { code: "forbidden", message: "Requested size cannot be allocated." } };
  const error = await launchSandbox(answering(refusal, 403), { ...args, size: "xlarge" }).catch((caught) => caught);
  expect(error).toBeInstanceOf(ControlError);
  expect(error).toMatchObject({ code: "forbidden", message: "Requested size cannot be allocated." });
  const unavailable = { error: { code: "payment_required", message: "Plan limit." } };
  expect(await launchSandbox(answering(unavailable, 503), args).catch((caught) => caught)).toMatchObject({
    code: "payment_required",
  });
});
