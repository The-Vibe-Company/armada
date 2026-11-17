import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { decryptSecret, encryptSecret, type Sql } from "@armada/core/server";
import {
  createOutboundWebhooks,
  pinnedLookup,
  postPinned,
  publicWebhookAddress,
  webhookSignature,
} from "../src/outbound-webhooks.ts";

const org = "00000000-0000-4000-8000-000000000001";
const key = Buffer.alloc(32, 7).toString("base64");

test("signature matches the receiver's HMAC contract and binds every signed field", () => {
  const body = '{"externalRef":"order_1"}';
  expect(webhookSignature("test_secret", "1700000000", "delivery_id", body)).toBe(
    "v1=4d2181ef48815cf28f9e520ca55953b6903d1324e6b48d6719084ba18148b62a",
  );
  for (const args of [
    ["test_secret", "1700000001", "delivery_id", body],
    ["test_secret", "1700000000", "other_id", body],
    ["test_secret", "1700000000", "delivery_id", `${body} `],
  ])
    expect(webhookSignature(...(args as [string, string, string, string]))).not.toBe(
      webhookSignature("test_secret", "1700000000", "delivery_id", body),
    );
});

test("public egress rejects internal, link local, reserved and IPv6 destinations", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "198.18.0.1",
    "::1",
    "::ffff:127.0.0.1",
  ])
    expect(publicWebhookAddress(address)).toBe(false);
  expect(publicWebhookAddress("8.8.8.8")).toBe(true);
});

test("management requires an authenticated admin in the selected token org before any SQL", async () => {
  const sql: Sql = {
    query: async () => {
      throw Error("SQL must not run");
    },
  };
  const hooks = createOutboundWebhooks(sql, key, "https://armada.example");
  for (const auth of [
    { ok: false } as const,
    { ok: true, caller: { userId: "user", via: "service", orgs: [{ orgId: org, role: "member" }] } } as const,
    { ok: true, caller: { userId: "user", via: "service", orgs: [{ orgId: "other", role: "admin" }] } } as const,
  ]) {
    const response = await hooks.route(async () => auth)(
      new Request(`https://armada.example/api/v1/webhooks?org=${org}`),
    );
    expect(response?.status).toBe(auth.ok ? 403 : 401);
  }
});

test("endpoint creation returns secret once while storing only ciphertext", async () => {
  let stored: unknown[] = [];
  const sql: Sql = {
    query: async <T>(_query: string, params?: unknown[]) => {
      stored = params ?? [];
      return { rows: [{ id: "endpoint_id", url: stored[1], enabled: true }] as T[] };
    },
  };
  const route = createOutboundWebhooks(sql, key, "https://armada.example").route(async () => ({
    ok: true,
    caller: { userId: "user", via: "service", orgs: [{ orgId: org, role: "admin" }] },
  }));
  const response = await route(
    new Request(`https://armada.example/api/v1/webhooks?org=${org}`, {
      method: "POST",
      body: JSON.stringify({ url: "https://receiver.example/events" }),
    }),
  );
  expect(response?.status).toBe(201);
  const result = (await response?.json()) as { secret: string; endpoint: { secret_enc?: unknown } };
  expect(result.secret).toHaveLength(64);
  expect(await decryptSecret(stored[2] as Uint8Array<ArrayBuffer>, key)).toBe(result.secret);
  expect(result.endpoint.secret_enc).toBeUndefined();
  expect(response?.headers.get("cache-control")).toBe("no-store");
});

test("delivery logs translate queued native receipts to the public send identity without exposing receipt content", async () => {
  const encrypted = await encryptSecret(
    JSON.stringify({ promptId: "native_prompt", privateText: "private_receipt" }),
    key,
  );
  const sql: Sql = {
    query: async <T>(query: string) => ({
      rows: (query.includes("account_turn_queue")
        ? [{ request_id: "public_request", result_enc: encrypted }]
        : [{ payload: { sandboxId: "sandbox_id", promptId: "native_prompt", type: "turn.finished" } }]) as T[],
    }),
  };
  const route = createOutboundWebhooks(sql, key, "https://armada.example").route(async () => ({
    ok: true,
    caller: { userId: "user", via: "service", orgs: [{ orgId: org, role: "admin" }] },
  }));
  const response = await route(new Request(`https://armada.example/api/v1/webhooks/deliveries?org=${org}`));
  expect(response?.status).toBe(200);
  const body = (await response?.json()) as { deliveries: { payload: { promptId: string } }[] };
  expect(body.deliveries[0]?.payload.promptId).toBe("public_request");
  expect(JSON.stringify(body)).not.toContain("private_receipt");
});

test("pinned lookup answers both the single-address and all-records callback contracts", () => {
  const single: unknown[] = [];
  pinnedLookup("203.0.114.7")("receiver.example", { all: false }, (...args) => single.push(...args));
  expect(single).toEqual([null, "203.0.114.7", 4]);
  const all: unknown[] = [];
  pinnedLookup("203.0.114.7")("receiver.example", { all: true }, (...args) => all.push(...args));
  expect(all).toEqual([null, [{ address: "203.0.114.7", family: 4 }]]);
});

test("HTTPS delivery to a hostname connects to the pinned address through the real request lookup", async () => {
  const connections: string[] = [];
  const server = createServer((socket) => {
    connections.push(socket.remoteAddress ?? "");
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const error = await postPinned(
      new URL(`https://receiver.example:${port}/hook`),
      "127.0.0.1",
      "{}",
      { "Content-Type": "application/json" },
      new AbortController().signal,
    ).catch((caught: unknown) => caught as NodeJS.ErrnoException);
    // The plain TCP fixture closes before TLS completes; reaching it proves lookup succeeded.
    expect(connections).toEqual(["127.0.0.1"]);
    expect((error as NodeJS.ErrnoException).code).not.toBe("ERR_INVALID_IP_ADDRESS");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
