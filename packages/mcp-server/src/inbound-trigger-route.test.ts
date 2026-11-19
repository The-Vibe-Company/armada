import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { inboundTriggerRoute, type VerifiedDelivery } from "./inbound-trigger-route.ts";

const id = "e8a9f7a2-747c-4a2f-936b-3f84238c4707";
const path = `/api/v1/hooks/${id}`;
const now = 1_800_000_000_000;
const key = Buffer.alloc(32, 42);
const event = "event\r\n非 JSON";
const deliveryId = "event_1";
const jobId = "durable-job";

function headers(timestamp = String(now / 1000), signedBody = event) {
  return new Headers({
    "x-armada-timestamp": timestamp,
    "x-armada-delivery-id": deliveryId,
    "x-armada-signature": createHmac("sha256", key)
      .update(`POST\n${path}\n${timestamp}\n${deliveryId}\n${signedBody}`)
      .digest("hex"),
  });
}

function request(body = event, signed = headers()) {
  return new Request(`https://fixture.invalid${path}`, { method: "POST", body, headers: signed });
}

function fixture() {
  const jobs: VerifiedDelivery[] = [];
  const route = inboundTriggerRoute(
    {
      signingKey: async () => ({ key, revision: 2 }),
      async admit(delivery) {
        if (jobs.some((job) => job.deliveryId === delivery.deliveryId)) return { status: "duplicate", jobId };
        jobs.push(delivery);
        return { status: "queued", jobId };
      },
    },
    () => now,
  );
  return { route, jobs };
}

test("authenticates exact event bytes and returns the queued delivery receipt", async () => {
  const { route, jobs } = fixture();
  const response = await route(request());
  expect(response?.status).toBe(202);
  expect(await response?.json()).toEqual({ triggerId: id, deliveryId, jobId });
  expect(jobs).toEqual([{ triggerId: id, deliveryId, revision: 2, timestamp: now, body: event }]);
});

test("a duplicate returns the original receipt with 200", async () => {
  const { route, jobs } = fixture();
  expect((await route(request()))?.status).toBe(202);
  const response = await route(request());
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ triggerId: id, deliveryId, jobId });
  expect(jobs).toHaveLength(1);
});

test.each([
  ["modified signed body", () => request(`${event}!`)],
  ["stale timestamp", () => request(event, headers(String(now / 1000 - 301)))],
  ["future timestamp", () => request(event, headers(String(now / 1000 + 301)))],
  [
    "duplicate delivery header",
    () => {
      const signed = headers();
      signed.append("x-armada-delivery-id", deliveryId);
      return request(event, signed);
    },
  ],
] as const)("rejects %s without admitting a delivery", async (_, makeRequest) => {
  const { route, jobs } = fixture();
  expect((await route(makeRequest()))?.status).toBe(401);
  expect(jobs).toHaveLength(0);
});

test("rejects a chunked event after it exceeds the byte limit", async () => {
  const { route, jobs } = fixture();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024));
      controller.enqueue(Uint8Array.of(1));
      controller.close();
    },
  });
  const response = await route(
    new Request(`https://fixture.invalid${path}`, {
      method: "POST",
      body,
      headers: headers(),
    }),
  );
  expect(response?.status).toBe(413);
  expect(jobs).toHaveLength(0);
});

test("returns the store's rate limit retry hint", async () => {
  const route = inboundTriggerRoute(
    {
      signingKey: async () => ({ key, revision: 2 }),
      admit: async () => ({ status: "rate_limited", retryAfter: 12 }),
    },
    () => now,
  );
  const response = await route(request());
  expect(response?.status).toBe(429);
  expect(response?.headers.get("retry-after")).toBe("12");
  expect(await response?.json()).toEqual({ error: "rate_limited", retryAfter: 12 });
});
