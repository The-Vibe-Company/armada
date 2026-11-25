import { expect, test } from "bun:test";
import { createMemoryAuthStore, generateToken, sha256Hex } from "@armada/auth";
import { sandboxViewerOperations } from "@armada/core/contract";
import published from "../openapi.json";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { controlRoutes } from "../src/modules.ts";
import { rejectUnroutedViewerRequest } from "../src/viewer-control.ts";

async function fixture(status: "ready" | "deleted" = "ready") {
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
    providers: {},
    data: () => ({
      sandboxes: {
        get: async (sandboxId: string) =>
          sandboxId === id
            ? {
                id,
                provider: "boat",
                status,
                golden: null,
                visibility: "private",
                harness: "codex",
                model: null,
                reasoningEffort: null,
                conversationIds: [],
              }
            : null,
      },
    }),
    dockerControls: {
      invoke: async (_caller: unknown, tool: string) => {
        if (tool === "logs") return { handled: true, result: { events: [], cursor: "opaque_cursor", hasMore: true } };
        if (tool === "send")
          return {
            handled: true,
            result: { id, promptId: "prompt", conversationId: "conversation", status: "running" },
          };
        return { handled: false };
      },
    },
    authStore,
    supabase: { supabaseUrl: "https://example.test", anonKey: "placeholder" },
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    now: () => time,
    store: {} as ControlOptions["store"],
  } as unknown as ControlOptions;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let visible = true;
  const dispatch = async (request: Request) => {
    const body = (await request.clone().json()) as Record<string, unknown>;
    const path = new URL(request.url).pathname;
    calls.push({ path, body });
    if (!visible) return new Response(null, { status: 403 });
    return handleControlRequest(request, options);
  };
  const api = (path: string, bearer: string, body?: object) => {
    const request = new Request(`https://example.test/api/v1/${path}`, {
      method: path.split("?")[0]!.endsWith("events") ? "GET" : "POST",
      headers: { authorization: `Bearer ${bearer}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const route = controlRoutes.get(path.split("?")[0]!);
    return route && "earlyRespond" in route
      ? route.earlyRespond(request, options, dispatch)
      : rejectUnroutedViewerRequest(request, options, dispatch);
  };
  const minted = await api("sandbox/viewer-token", token, { id });
  const grant = sandboxViewerOperations.mint.output.parse(await minted!.json());
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
  const replayId = crypto.randomUUID();
  const sent = await f.api("viewer/send", f.grant.token, {
    message: "hello",
    id: "other",
    org: "other",
    model: "other",
    requestId: replayId,
  });
  expect(sent?.status).toBe(200);
  expect(sandboxViewerOperations.send.output.parse(await sent!.json()).id).toBe(f.id);
  expect(f.calls).toEqual([
    { path: "/api/v1/sandbox/send", body: { id: f.id, prompt: "hello", request_id: replayId } },
  ]);
  for (const path of ["viewer/exec", "sandbox/viewer-token", "sandbox/stop", "runtime/channel"])
    expect((await f.api(path, f.grant.token, { id: f.id }))!.status).toBe(403);
});

test("viewer status reads the grant's sandbox through the status handler", async () => {
  const f = await fixture("deleted");
  const response = await f.api("viewer/status", f.grant.token, { id: crypto.randomUUID() });
  expect(response?.status).toBe(200);
  expect(sandboxViewerOperations.status.output.parse(await response!.json())).toMatchObject({
    id: f.id,
    status: "deleted",
  });
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

test("mint refuses invisible sandboxes and non-service bearers", async () => {
  const f = await fixture();
  f.hide();
  expect((await f.api("sandbox/viewer-token", f.token, { id: f.id }))!.status).toBe(403);
  expect((await f.api("sandbox/viewer-token", "invalid_bearer", { id: f.id }))!.status).toBe(403);
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
  expect(sandboxViewerOperations.logs.output.parse(await response!.json()).cursor).toBe(cursor);
  expect(received).toBe(cursor);
});

test("viewer routes preserve access-denied responses for invalid operation inputs", async () => {
  const f = await fixture();
  for (const [action, path, bearer, body] of [
    ["mint", "sandbox/viewer-token", f.token, { id: "invalid" }],
    ["logs", "viewer/logs", f.grant.token, { cursor: 42 }],
    ["status", "viewer/status", f.grant.token, { cursor: "bad\n" }],
    ["send", "viewer/send", f.grant.token, { message: " \t " }],
  ] as const) {
    const response = await f.api(path, bearer, body);
    expect(response?.status).toBe(400);
    expect(sandboxViewerOperations[action].errorOutput.parse(await response?.json())).toEqual({
      error: "viewer_access_denied",
    });
  }
  expect(f.calls).toHaveLength(0);
});

test("viewer send forwards a structured sandbox refusal", async () => {
  const f = await fixture("deleted");
  const response = await f.api("viewer/send", f.grant.token, { message: "hello" });
  expect(response?.status).toBe(409);
  expect(sandboxViewerOperations.send.errorOutput.parse(await response!.json())).toMatchObject({
    error: { code: "sandbox_terminal" },
  });
});

test("viewer POSTs refuse oversized bodies at their published limits before dispatch", async () => {
  const f = await fixture("deleted");
  const cases = [
    ["sandbox/viewer-token", f.token, { id: f.id }, 200],
    ["viewer/logs", f.grant.token, {}, 200],
    ["viewer/status", f.grant.token, {}, 200],
    ["viewer/send", f.grant.token, { message: "hello" }, 409],
  ] as const;
  for (const [route, token, input, admittedStatus] of cases) {
    const contract = published.paths[`/api/v1/${route}`].post.requestBody as {
      "x-max-body-bytes"?: number;
      "x-oversized-body-status"?: number;
    };
    const limit = contract["x-max-body-bytes"];
    expect(limit ?? 0).toBeGreaterThan(0);
    const padding = limit! - Buffer.byteLength(JSON.stringify({ ...input, pad: "" }));
    expect([route, (await f.api(route, token, { ...input, pad: "x".repeat(padding) }))?.status]).toEqual([
      route,
      admittedStatus,
    ]);
    const dispatched = f.calls.length;
    const refused = await f.api(route, token, { ...input, pad: "x".repeat(padding + 1) });
    expect(refused?.status).toBe(contract["x-oversized-body-status"]);
    expect(f.calls).toHaveLength(dispatched);
    expect(await refused!.json()).toEqual({ error: "viewer_access_denied" });
  }
});

test("the published event feed admits a viewer only for its grant's sandbox and a valid issuer", async () => {
  expect(published.paths["/api/v1/events"].get.security).toContainEqual({ viewerGrant: [] });
  const f = await fixture();
  f.options.eventFeed = {
    owner: () => async () => [],
    child: () => async () => null,
  };
  const path = `events?sandbox=${f.id}`;
  const allowed = await f.api(path, f.grant.token);
  expect(allowed?.headers.get("content-type")).toBe("text/event-stream");
  await allowed?.body?.cancel();
  expect((await f.api(`events?sandbox=${crypto.randomUUID()}`, f.grant.token))?.status).toBe(403);
  await f.revoke();
  expect((await f.api(path, f.grant.token))?.status).toBe(403);
});
