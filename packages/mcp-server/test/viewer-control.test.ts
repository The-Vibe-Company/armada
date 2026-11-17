import { expect, test } from "bun:test";
import { createMemoryAuthStore, generateToken, sha256Hex } from "@armada/auth";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { viewerControl } from "../src/viewer-control.ts";

async function fixture() {
  let time = new Date("2026-11-17T12:00:00Z");
  const authStore = createMemoryAuthStore();
  const userId = crypto.randomUUID(),
    orgId = crypto.randomUUID(),
    id = crypto.randomUUID();
  authStore.addMembership(userId, { orgId, name: "example", role: "member" });
  const token = generateToken("service");
  const hash = await sha256Hex(token);
  await authStore.insertToken("service", { userId, orgId, hash, label: "viewer", createdAt: time.toISOString() });
  const options = {
    authStore,
    supabase: { supabaseUrl: "https://example.test", anonKey: "placeholder" },
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    now: () => time,
  };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let visible = true;
  const dispatch = async (request: Request) => {
    const body = (await request.json()) as Record<string, unknown>;
    calls.push({ path: new URL(request.url).pathname, body });
    return visible
      ? Response.json({ events: [{ type: "message", text: "hello" }], cursor: "opaque_cursor", hasMore: true })
      : new Response(null, { status: 403 });
  };
  const api = (path: string, bearer: string, body?: object) =>
    viewerControl(
      new Request(`https://example.test/api/v1/${path}`, {
        method: path.split("?")[0]!.endsWith("events") ? "GET" : "POST",
        headers: { authorization: `Bearer ${bearer}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      options,
      dispatch,
    );
  const minted = await api("sandbox/viewer-token", token, { id });
  const grant = (await minted!.json()) as { token: string };
  calls.length = 0;
  return {
    api,
    options,
    grant,
    calls,
    id,
    token,
    revoke: () => authStore.revokeTokenByHash("service", hash, time.toISOString()),
    expire: () => {
      time = new Date(time.getTime() + 300_000);
    },
    hide: () => {
      visible = false;
    },
  };
}

test("viewer confines dispatch to one sandbox and read/send fields", async () => {
  const f = await fixture();
  expect(f.grant.token).not.toContain(f.token);
  expect(
    (await f.api("viewer/send", f.grant.token, {
      message: "hello",
      id: "other",
      org: "other",
      model: "other",
      requestId: "request_id",
    }))!.status,
  ).toBe(200);
  expect(f.calls).toEqual([
    { path: "/api/v1/sandbox/send", body: { id: f.id, prompt: "hello", request_id: "request_id" } },
  ]);
  for (const path of ["viewer/exec", "sandbox/viewer-token", "sandbox/stop", "runtime/channel"])
    expect((await f.api(path, f.grant.token, { id: f.id }))!.status).toBe(403);
});

test("viewer rejects expiry, tampering and revoked issuing tokens", async () => {
  const f = await fixture();
  expect((await f.api("viewer/logs", f.grant.token + "broken", {}))!.status).toBe(401);
  await f.revoke();
  expect((await f.api("viewer/logs", f.grant.token, {}))!.status).toBe(401);
  f.expire();
  expect((await f.api("viewer/status", f.grant.token, {}))!.status).toBe(401);
  expect(f.calls).toHaveLength(0);
});

test("stream resumes bounded pages on demand and rechecks access between pages", async () => {
  const f = await fixture();
  const stream = await f.api("viewer/events?cursor=resume_cursor", f.grant.token);
  expect(f.calls[0]!.body.cursor).toBe("resume_cursor");
  expect(f.calls).toHaveLength(1);
  const reader = stream!.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"cursor":"opaque_cursor"');
  expect(f.calls).toHaveLength(1);
  f.hide();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("access-ended");
  expect(f.calls[1]!.body).toEqual({ id: f.id, cursor: "opaque_cursor", limit: 100, maxBytes: 65536 });
  expect((await reader.read()).done).toBe(true);
});

test("mint refuses invisible sandboxes and non-service bearers", async () => {
  const f = await fixture();
  f.hide();
  expect((await f.api("sandbox/viewer-token", f.token, { id: f.id }))!.status).toBe(403);
  expect((await f.api("sandbox/viewer-token", "invalid_bearer", { id: f.id }))!.status).toBe(403);
});

test("stream does not deliver its prefetched page after grant expiry", async () => {
  const f = await fixture();
  const stream = await f.api("viewer/events", f.grant.token);
  f.expire();
  const reader = stream!.body!.getReader();
  expect((await reader.read()).done).toBe(true);
});

test("viewer polling preserves large provider continuation cursors through control HTTP", async () => {
  const f = await fixture();
  let received: unknown;
  const options = {
    ...f.options,
    dockerControls: {
      invoke: async (_caller: unknown, _tool: string, args: Record<string, unknown>) => {
        received = args.since_cursor;
        return {
          handled: true,
          result: { events: [], cursor: args.since_cursor ?? null, hasMore: false, settled: true },
        };
      },
    },
  } as unknown as ControlOptions;
  const cursor = "opaque_" + "x".repeat(150000);
  const response = await handleControlRequest(
    new Request("https://example.test/api/v1/viewer/logs", {
      method: "POST",
      headers: { authorization: `Bearer ${f.grant.token}` },
      body: JSON.stringify({ cursor }),
    }),
    options,
  );
  expect(response!.status).toBe(200);
  expect(received).toBe(cursor);
});
