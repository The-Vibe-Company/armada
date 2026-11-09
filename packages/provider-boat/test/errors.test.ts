import { describe, expect, test } from "bun:test";
import { ProviderError, type ProviderErrorCode } from "@armada/core";
import { errorBody, fakeBoat, KEY } from "./support.ts";

type Case = [
  name: string,
  reply: ReturnType<typeof errorBody>,
  expected: Partial<ProviderError> & { code: ProviderErrorCode },
];

const cases: Case[] = [
  ["bad key", errorBody(401, "unauthorized", "Unauthorized"), { code: "unauthorized", retryable: false }],
  ["billing", errorBody(402, "billing_required", "Add credit"), { code: "payment_required", retryable: false }],
  ["suspended org", errorBody(403, "org_suspended", "Suspended"), { code: "forbidden", retryable: false }],
  ["unknown snapshot", errorBody(404, "snapshot_not_found", "No such snapshot"), { code: "not_found" }],
  ["bad request", errorBody(400, "invalid_name", "Bad name"), { code: "invalid_request", retryable: false }],
  [
    "harness not set up",
    errorBody(409, "provider_not_configured", "Prompting is locked until Codex is configured", {
      provider: "codex",
      setupUrl: "https://boat.dev/dashboard?tab=agents",
    }),
    {
      code: "provider_not_configured",
      retryable: false,
      details: { provider: "codex", setupUrl: "https://boat.dev/dashboard?tab=agents" },
    },
  ],
  [
    "steer with no turn",
    errorBody(409, "no_running_turn", "Nothing runs", { reason: "turn_ended" }),
    { code: "no_running_turn", details: { reason: "turn_ended" } },
  ],
  ["still starting", errorBody(409, "sandbox_starting", "Starting"), { code: "sandbox_not_ready", retryable: true }],
  ["no machine", errorBody(409, "machine_not_running", "Stopped"), { code: "sandbox_not_ready", retryable: false }],
  [
    "machine missing on a 400",
    errorBody(400, "machine_not_running", "Stopped"),
    { code: "sandbox_not_ready", retryable: false },
  ],
  ["create in flight", errorBody(409, "idempotency_in_progress", "In progress"), { code: "conflict", retryable: true }],
  ["key reused", errorBody(409, "idempotency_key_reused", "Reused"), { code: "conflict", retryable: false }],
  [
    "start limit per minute",
    errorBody(429, "rate_limited", "Slow down", { window: "minute", limit: 12, retryAfter: 20 }),
    { code: "rate_limited", retryable: true, retryAfterSeconds: 20 },
  ],
  [
    "start limit per day",
    errorBody(429, "rate_limited", "Done today", { window: "day", limit: 200 }),
    { code: "rate_limited", retryable: false },
  ],
  ["too many sandboxes", errorBody(429, "limit_reached", "Full"), { code: "rate_limited", retryable: false }],
  [
    "no capacity",
    errorBody(503, "out_of_capacity", "Full", undefined, { retryAfterSeconds: 5 }),
    { code: "unavailable", retryable: true, retryAfterSeconds: 5 },
  ],
  [
    "machine failure that may be repeated",
    errorBody(502, "sandbox_direct_failed", "x", { retryable: true }),
    { code: "unavailable", retryable: true },
  ],
  [
    "machine failure that must not",
    errorBody(502, "sandbox_direct_failed", "x", { retryable: false }),
    { code: "unavailable", retryable: false },
  ],
  ["server error", errorBody(500, "http_500", "Oops"), { code: "unavailable", retryable: true }],
];

describe("boat errors become typed errors", () => {
  test.each(cases)("%s", async (_name, reply, expected) => {
    const boat = fakeBoat(reply);
    const error = await boat.provider.get("bx_23456789").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: "boat", status: reply.status, ...expected });
  });

  test("the message, boat's code and the request id come through", async () => {
    const boat = fakeBoat(errorBody(409, "provider_not_configured", "Prompting is locked until Codex is configured"));
    const error = (await boat.provider.get("bx_1").catch((e: unknown) => e)) as ProviderError;
    expect(error.message).toBe("Prompting is locked until Codex is configured");
    expect(error.providerCode).toBe("provider_not_configured");
    expect(error.requestId).toBe("req_test");
  });

  test("an answer that is not boat's envelope is still typed, with the Retry-After header", async () => {
    const boat = fakeBoat({ status: 429, body: "slow", headers: { "retry-after": "30" } });
    const error = await boat.provider.get("bx_1").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "rate_limited", status: 429, retryAfterSeconds: 30 });
  });

  test("a network failure is unavailable and retryable", async () => {
    const boat = fakeBoat(new TypeError("fetch failed"));
    const error = await boat.provider.get("bx_1").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unavailable", retryable: true });
    expect((error as Error).message).toContain("fetch failed");
  });

  test.each([
    [403, "machine_class_plan_required", "xlarge"],
    [400, "type_too_small", "small"],
  ] as const)(
    "size refusal %s %s preserves provider evidence and never retries another size",
    async (status, providerCode, size) => {
      const boat = fakeBoat(errorBody(status, providerCode, "Requested size cannot be allocated"));
      await expect(boat.provider.fork({ from: "source", size })).rejects.toMatchObject({
        providerCode,
        status,
        retryable: false,
      });
      expect(boat.requests).toHaveLength(1);
      expect(boat.requests[0]).toMatchObject({
        method: "POST",
        path: "/api/v1/sandboxes",
        body: { from: "source", type: size },
      });
    },
  );

  test("neither the API key nor an injected credential appears in an error", async () => {
    const boat = fakeBoat(errorBody(409, "fork_failed", "Fork failed"));
    const error = (await boat.provider
      .fork({ from: "g", env: { ANTHROPIC_API_KEY: "sk-secret-value" } })
      .catch((e: unknown) => e)) as ProviderError;
    const shown = JSON.stringify({ message: error.message, details: error.details, code: error.providerCode });
    expect(shown).not.toContain("sk-secret-value");
    expect(shown).not.toContain(KEY);
  });
});
