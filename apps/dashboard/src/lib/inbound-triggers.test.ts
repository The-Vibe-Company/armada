import { expect, test } from "bun:test";
import { createInboundTriggerControl } from "./inbound-triggers.ts";

const org = "00000000-0000-4000-8000-000000000010";
const id = "00000000-0000-4000-8000-000000002220";
const options = { serverUrl: "https://api.invalid/mcp", token: "viewer" };

function fakeFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return Object.assign(handler, { preconnect: () => {} });
}

test("inspects redacted trigger metadata without passing signing material to the page", async () => {
  const summary = {
    id,
    templateId: null,
    poolHarness: "codex" as const,
    enabled: true,
    ratePerMinute: 25,
    concurrency: 2,
    rateRefusals: 0,
  };
  const control = createInboundTriggerControl(
    {
      ...options,
      fetch: fakeFetch(async (url, init) => {
        expect(String(url)).toBe(`https://api.invalid/api/v1/triggers?org=${org}`);
        expect(init).toMatchObject({ method: "GET", cache: "no-store", headers: { authorization: "Bearer viewer" } });
        return Response.json({ triggers: [{ ...summary, signingSecret: "hidden", secretEnc: "opaque" }] });
      }),
    },
    org,
  );

  expect(await control.list()).toEqual([summary]);
});

test("projects processing state without payload and rejects unknown states", async () => {
  const delivery = { deliveryId: "event_1", receivedAt: "2026-11-19T10:00:00Z" };
  let jobState = "done";
  const control = createInboundTriggerControl(
    {
      ...options,
      fetch: fakeFetch(async () => Response.json({ deliveries: [{ ...delivery, jobState, body: "hidden" }] })),
    },
    org,
  );
  expect(await control.deliveries(id)).toEqual([{ ...delivery, processingState: "Processed" }]);
  jobState = "unknown";
  await expect(control.deliveries(id)).rejects.toThrow("unexpected inbound trigger response");
});

test("returns the key only from an uncached, org-scoped rotation mutation", async () => {
  let signingSecret = Buffer.alloc(32, 42).toString("base64");
  const control = createInboundTriggerControl(
    {
      ...options,
      fetch: fakeFetch(async (url, init) => {
        expect(String(url)).toBe(`https://api.invalid/api/v1/triggers/${id}/rotate?org=${org}`);
        expect(init).toMatchObject({ method: "POST", cache: "no-store" });
        return Response.json({ signingSecret });
      }),
    },
    org,
  );
  expect(await control.rotate(id)).toBe(signingSecret);
  signingSecret = "invalid";
  await expect(control.rotate(id)).rejects.toThrow("unexpected inbound trigger response");
});

test("accepts the empty disable response and surfaces refused requests", async () => {
  let status = 204;
  const control = createInboundTriggerControl(
    {
      ...options,
      fetch: fakeFetch(async (url, init) => {
        expect(String(url)).toBe(`https://api.invalid/api/v1/triggers/${id}/disable?org=${org}`);
        expect(init?.method).toBe("POST");
        return new Response(null, { status });
      }),
    },
    org,
  );
  expect(await control.disable(id)).toBeUndefined();
  status = 403;
  await expect(control.disable(id)).rejects.toMatchObject({ status: 403 });
});
