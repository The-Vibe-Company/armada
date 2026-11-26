import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import SandboxPage from "@/app/(app)/sandboxes/[id]/page";
import { disconnectGitHub } from "@/app/actions/github";
import { execSandbox, interruptSandbox, sendToSandbox, steerSandbox, stopSandbox } from "@/app/actions/sandboxes";
import { GET as getSandboxEvents } from "@/app/api/sandboxes/[id]/events/route";
import { SEND_KEY_FIELD } from "@/lib/composer";
import { type ModelAccount, parseAccount } from "@/lib/model-accounts";
import type { Database } from "@/lib/supabase/types";
import { listSelectedAccounts, readConnectionTestChoices } from "./model-accounts";
import { readSandboxConversation } from "./sandbox-conversation";

const viewer = { id: "owner", email: "owner@example.test", token: "viewer" };
let activeViewer: typeof viewer | null = viewer;
const selected = { org: { id: "org", name: "Org" }, role: "admin" };
const origin = "https://dashboard.test";
const timestamp = "2026-11-01T00:00:00Z";
const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const account = {
  id: firstId,
  name: "API account",
  scope: "user",
  kind: "openai",
  status: "active",
  version: 2,
  expiresAt: null,
  updatedAt: timestamp,
};
const revalidatedPaths: string[] = [];

const actualViewer = await import("./viewer");
const realMemberDirectory = actualViewer.memberDirectory;
const realDisplayUser = actualViewer.displayUser;

mock.module("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidatedPaths.push(path);
  },
}));
mock.module("./viewer", () => ({
  readViewer: async () => activeViewer,
  requireViewer: async () => viewer,
  listMemberships: async () => [selected],
  memberDirectory: realMemberDirectory,
  displayUser: realDisplayUser,
}));
mock.module("./selected-org", () => ({ selectedOrganization: async () => selected }));
mock.module("@/lib/env", () => ({ mcpUrl: () => origin }));
mock.module("@/lib/supabase/server", () => ({
  createClient: async () =>
    createClient<Database>(origin, "anon", {
      accessToken: async () => viewer.token,
      global: { fetch },
    }),
}));

function recordFetch(reply: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const fetchResponse = async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    reply(new URL(input instanceof Request ? input.url : String(input)), init);
  const fetchFixture = Object.assign(fetchResponse, { preconnect: fetch.preconnect });
  // oxlint-disable-next-line landmines-testing/no-test-doubles -- Feed both real clients HTTP responses and hold the credential response without sockets or timers.
  return spyOn(globalThis, "fetch").mockImplementation(fetchFixture);
}

function sandboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: firstId,
    owner_id: viewer.id,
    org_id: selected.org.id,
    provider: "modal",
    boat_runtime: false,
    runtime_transport: null,
    golden_id: secondId,
    credential_id: null,
    conversation_ids: [],
    harness: "codex",
    status: "ready",
    status_reason: null,
    expires_at: null,
    usage_turns: null,
    created_at: timestamp,
    ...overrides,
  };
}

afterEach(() => {
  activeViewer = viewer;
  revalidatedPaths.length = 0;
  mock.restore();
});

test("connection checks batch eligible accounts and keep each account's recent current-version sandboxes", async () => {
  const first = parseAccount(account)!;
  const second: ModelAccount = { ...first, id: secondId, version: 4 };
  const row = {
    owner_id: viewer.id,
    org_id: selected.org.id,
    provider: "modal",
    boat_runtime: false,
    status: "ready",
    stop_requested_at: null,
    credential_id: first.id,
    credential_version: first.version,
    harness: "codex",
    created_at: timestamp,
  };
  const queries: URLSearchParams[] = [];
  recordFetch((url) => {
    expect(url.pathname).toBe("/rest/v1/sandboxes");
    queries.push(url.searchParams);
    return Response.json([
      { ...row, id: "stale", credential_version: 1 },
      ...Array.from({ length: 51 }, (_, index) => ({ ...row, id: `first-${index}` })),
      { ...row, id: "second", credential_id: second.id, credential_version: second.version },
    ]);
  });

  const result = await readConnectionTestChoices([first, second, { ...first, id: "revoked", status: "revoked" }]);
  expect(queries).toHaveLength(1);
  expect(queries[0]?.get("credential_id")).toBe(`in.(${firstId},${secondId})`);
  expect(queries[0]?.get("owner_id")).toBe(`eq.${viewer.id}`);
  expect(queries[0]?.get("org_id")).toBe(`eq.${selected.org.id}`);
  expect(result.state === "ready" && result.sandboxes.map(({ id }) => id)).toEqual([
    ...Array.from({ length: 50 }, (_, index) => `first-${index}`),
    "second",
  ]);
});

test("connection checks exclude accounts that reached their cap from the next page", async () => {
  const first = parseAccount(account)!;
  const second: ModelAccount = { ...first, id: secondId };
  const row = {
    owner_id: viewer.id,
    org_id: selected.org.id,
    provider: "modal",
    boat_runtime: false,
    status: "running",
    stop_requested_at: null,
    credential_id: first.id,
    credential_version: first.version,
    harness: "codex",
    created_at: timestamp,
  };
  const queries: URLSearchParams[] = [];
  recordFetch((url) => {
    queries.push(url.searchParams);
    return queries.length === 1
      ? Response.json(Array.from({ length: 500 }, (_, index) => ({ ...row, id: `first-${index}` })))
      : Response.json([{ ...row, id: "second", credential_id: second.id }]);
  });

  const result = await readConnectionTestChoices([first, second]);
  expect(queries).toHaveLength(2);
  expect(queries[1]?.get("credential_id")).toBe(`in.(${secondId})`);
  expect(queries[1]?.getAll("or")).toContain(
    `(created_at.lt.${timestamp},and(created_at.eq.${timestamp},id.gt.first-499))`,
  );
  expect(result.state === "ready" && result.sandboxes.map(({ id }) => id)).toEqual([
    ...Array.from({ length: 50 }, (_, index) => `first-${index}`),
    "second",
  ]);
});

test("account listing starts the model read while the credential response is pending", async () => {
  const listed = Promise.withResolvers<Response>();
  const listStarted = Promise.withResolvers<void>();
  const requests: string[] = [];
  recordFetch((url) => {
    requests.push(url.pathname);
    if (url.pathname === "/api/v1/creds/list") {
      listStarted.resolve();
      return listed.promise;
    }
    expect(url.pathname).toBe("/api/v1/creds/accounts/models");
    return Response.json({ connections: [{ id: firstId, models: [{ model: "example-model" }] }] });
  });

  const result = listSelectedAccounts();
  await listStarted.promise;
  const requestsBeforeListResponse = [...requests];
  listed.resolve(Response.json({ user: [account] }));

  expect(await result).toMatchObject({
    state: "ready",
    accounts: [{ id: firstId, models: [{ model: "example-model" }] }],
  });
  expect(requestsBeforeListResponse).toEqual(["/api/v1/creds/list", "/api/v1/creds/accounts/models"]);
});

function findElementsByTypeName(root: unknown, name: string) {
  const matches: Array<{ type: (props: unknown) => unknown; props: unknown }> = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    const record = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof record.type === "function" && record.type.name === name) {
      matches.push({ type: record.type as (props: unknown) => unknown, props: record.props });
    }
    if (record.props && typeof record.props === "object") stack.push(...Object.values(record.props));
  }
  return matches;
}

test.each(["starting", "running", "stopping"] as const)(
  "sandbox detail omits account choices and does not block on inspector reads while %s",
  async (status) => {
    const requests = recordFetch((url) => {
      switch (url.pathname) {
        case "/rest/v1/sandboxes":
          return Response.json([sandboxRow({ status })]);
        case "/rest/v1/rpc/sandbox_detail_status":
          return Response.json(status);
        default:
          throw new Error(`Unexpected blocking request ${url.pathname}`);
      }
    });

    const tree = await SandboxPage({ params: Promise.resolve({ id: firstId }) });
    expect(tree).toBeTruthy();
    expect(requests.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/rest/v1/sandboxes",
      "/rest/v1/rpc/sandbox_detail_status",
    ]);
    expect(findElementsByTypeName(tree, "SandboxAccountChoiceSection")).toHaveLength(0);
  },
);

test("sandbox detail mounts account choices inside Suspense when ready without blocking SSR", async () => {
  const requests = recordFetch((url) => {
    switch (url.pathname) {
      case "/rest/v1/sandboxes":
        return Response.json([sandboxRow({ status: "ready" })]);
      case "/rest/v1/rpc/sandbox_detail_status":
        return Response.json("ready");
      case "/api/v1/creds/list":
        return Response.json({ user: [] });
      case "/api/v1/creds/accounts/models":
        return Response.json({ connections: [] });
      default:
        throw new Error(`Unexpected request ${url.pathname}`);
    }
  });

  const tree = await SandboxPage({ params: Promise.resolve({ id: firstId }) });
  expect(requests.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
    "/rest/v1/sandboxes",
    "/rest/v1/rpc/sandbox_detail_status",
  ]);
  const sections = findElementsByTypeName(tree, "SandboxAccountChoiceSection");
  expect(sections).toHaveLength(1);
  await sections[0]!.type(sections[0]!.props);
  expect(requests.mock.calls.map(([input]) => new URL(String(input)).pathname)).toContain("/api/v1/creds/list");
});

test("Docker sandbox detail streams launch/options inside Suspense without blocking top-level SSR", async () => {
  const requests = recordFetch((url) => {
    switch (url.pathname) {
      case "/rest/v1/sandboxes":
        return Response.json([sandboxRow({ provider: "docker", golden_id: null, status: "ready" })]);
      case "/rest/v1/rpc/sandbox_detail_status":
        return Response.json("ready");
      case "/api/v1/launch/options":
        return Response.json({
          providers: [
            {
              id: "docker",
              enabled: true,
              launchSources: ["image"],
              harnesses: ["codex"],
              capabilities: { logs: true, followupPrompts: true, stop: true, delete: true, exec: true },
            },
          ],
        });
      default:
        throw new Error(`Unexpected request ${url.pathname}`);
    }
  });

  const tree = await SandboxPage({ params: Promise.resolve({ id: firstId }) });
  expect(requests.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
    "/rest/v1/sandboxes",
    "/rest/v1/rpc/sandbox_detail_status",
  ]);
  const docker = findElementsByTypeName(tree, "DockerSandbox");
  expect(docker).toHaveLength(1);
  const dockerTree = docker[0]!.type(docker[0]!.props);
  const headerActions = findElementsByTypeName(dockerTree, "DockerHeaderActions");
  const conversation = findElementsByTypeName(dockerTree, "DockerConversationSection");
  expect(headerActions).toHaveLength(1);
  expect(conversation).toHaveLength(1);
  await Promise.all([headerActions[0]!.type(headerActions[0]!.props), conversation[0]!.type(conversation[0]!.props)]);
  expect(requests.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
    "/rest/v1/sandboxes",
    "/rest/v1/rpc/sandbox_detail_status",
    "/api/v1/launch/options",
  ]);
});

test("conversation reads request limit 200 with coalesce and skip sandbox/status when threadStatus is returned", async () => {
  const apiBodies: { path: string; body: Record<string, unknown> }[] = [];
  recordFetch((url, init) => {
    if (url.pathname === "/rest/v1/sandboxes") return Response.json([sandboxRow({ provider: "docker" })]);
    if (url.pathname === "/rest/v1/rpc/sandbox_detail_status") return Response.json("ready");
    if (url.pathname === "/api/v1/logs/read") {
      apiBodies.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({
        events: [],
        cursor: "12",
        hasMore: false,
        threadStatus: { status: "running", statusMessage: "Working", prompt: null, usage: null },
      });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });

  const response = await readSandboxConversation(firstId, "10", "history");
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ status: "running", statusMessage: "Working", cursor: "12", backward: true });
  expect(apiBodies).toEqual([
    {
      path: "/api/v1/logs/read",
      body: { id: firstId, cursor: "10", limit: 200, coalesce: true, direction: "backward" },
    },
  ]);
});

test("conversation reads parallelize sandbox/status with logs/read when threadStatus is not provided", async () => {
  const logsReply = Promise.withResolvers<Response>();
  const logsStarted = Promise.withResolvers<void>();
  const statusStarted = Promise.withResolvers<void>();
  const apiPaths: string[] = [];
  recordFetch((url) => {
    if (url.pathname === "/rest/v1/sandboxes") return Response.json([sandboxRow({ provider: "modal" })]);
    if (url.pathname === "/rest/v1/rpc/sandbox_detail_status") return Response.json("ready");
    apiPaths.push(url.pathname);
    if (url.pathname === "/api/v1/logs/read") {
      logsStarted.resolve();
      return logsReply.promise;
    }
    if (url.pathname === "/api/v1/sandbox/status") {
      statusStarted.resolve();
      return Response.json({ status: "running", statusMessage: null, prompt: null });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });

  const read = readSandboxConversation(firstId, null, "follow");
  await Promise.all([logsStarted.promise, statusStarted.promise]);
  const pathsBeforeLogsFinished = [...apiPaths];
  logsReply.resolve(Response.json({ events: [], cursor: "5", hasMore: false }));

  const response = await read;
  expect(pathsBeforeLogsFinished).toEqual(["/api/v1/sandbox/status", "/api/v1/logs/read"]);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ status: "running", cursor: "5" });
});

test("conversation reads parallelize queued prompt status on host sandboxes and fall back when threadStatus is absent", async () => {
  const logsReply = Promise.withResolvers<Response>();
  const statusStarted = Promise.withResolvers<void>();
  const statusBodies: Record<string, unknown>[] = [];
  recordFetch((url, init) => {
    if (url.pathname === "/rest/v1/sandboxes") return Response.json([sandboxRow({ provider: "docker" })]);
    if (url.pathname === "/rest/v1/rpc/sandbox_detail_status") return Response.json("ready");
    if (url.pathname === "/api/v1/logs/read") return logsReply.promise;
    if (url.pathname === "/api/v1/sandbox/status") {
      statusBodies.push(JSON.parse(String(init?.body)));
      statusStarted.resolve();
      return Response.json({ status: "running", statusMessage: "Queued", prompt: { promptId: requestId } });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });

  const pendingRead = readSandboxConversation(firstId, null, "follow", requestId);
  await statusStarted.promise;
  logsReply.resolve(Response.json({ events: [], cursor: "1", hasMore: false }));
  expect((await pendingRead).body).toMatchObject({ status: "running", prompt: { promptId: requestId } });
  expect(statusBodies).toEqual([{ id: firstId, prompt_id: requestId }]);

  statusBodies.length = 0;
  recordFetch((url, init) => {
    if (url.pathname === "/rest/v1/sandboxes") return Response.json([sandboxRow({ provider: "docker" })]);
    if (url.pathname === "/rest/v1/rpc/sandbox_detail_status") return Response.json("ready");
    if (url.pathname === "/api/v1/logs/read") return Response.json({ events: [], cursor: "2", hasMore: false });
    if (url.pathname === "/api/v1/sandbox/status") {
      statusBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ status: "running", statusMessage: "Fallback", prompt: null });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  const fallbackRead = await readSandboxConversation(firstId, null, "follow");
  expect(fallbackRead.status).toBe(200);
  expect(fallbackRead.body).toMatchObject({ status: "running", statusMessage: "Fallback", cursor: "2" });
  expect(statusBodies).toEqual([{ id: firstId }]);
});

test("send, steer and interrupt use 1-RTT REST without revalidating while stop still revalidates", async () => {
  const apiCalls: { path: string; body: Record<string, unknown> }[] = [];
  recordFetch((url, init) => {
    if (url.pathname === "/rest/v1/sandboxes") return Response.json([sandboxRow({ status: "running" })]);
    if (url.pathname === "/rest/v1/rpc/sandbox_detail_status") return Response.json("running");
    if (url.pathname.startsWith("/api/v1/")) {
      apiCalls.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      if (url.pathname === "/api/v1/sandbox/send") return Response.json({ id: firstId, promptId: "p-1" });
      if (url.pathname === "/api/v1/sandbox/steer") return Response.json({ id: firstId, delivery: "in-place" });
      if (url.pathname === "/api/v1/sandbox/interrupt") return Response.json({ id: firstId, interrupted: true });
      if (url.pathname === "/api/v1/sandbox/exec")
        return Response.json({ id: firstId, stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false });
      if (url.pathname === "/api/v1/sandbox/stop") return Response.json({ id: firstId, status: "stopping" });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });

  const sendForm = new FormData();
  sendForm.set("sandbox", firstId);
  sendForm.set("prompt", "hello");
  sendForm.set(SEND_KEY_FIELD, requestId);
  expect(await sendToSandbox(null, sendForm)).toEqual({ ok: true, message: "Sent.", promptId: "p-1" });

  const steerForm = new FormData();
  steerForm.set("sandbox", firstId);
  steerForm.set("prompt", "change direction");
  expect(await steerSandbox(null, steerForm)).toEqual({ ok: true, message: "Steered." });

  const interruptForm = new FormData();
  interruptForm.set("sandbox", firstId);
  expect(await interruptSandbox(null, interruptForm)).toEqual({ ok: true, message: "Interrupt requested." });

  const execForm = new FormData();
  execForm.set("sandbox", firstId);
  execForm.set("command", "echo ok");
  expect(await execSandbox(null, execForm)).toEqual({ ok: true, message: "ok\n\nExit 0" });

  expect(revalidatedPaths).toEqual([]);

  const stopForm = new FormData();
  stopForm.set("sandbox", firstId);
  expect(await stopSandbox(null, stopForm)).toMatchObject({ ok: true });
  expect(revalidatedPaths).toEqual([`/sandboxes/${firstId}`, "/sandboxes"]);

  expect(apiCalls).toEqual([
    { path: "/api/v1/sandbox/send", body: { id: firstId, prompt: "hello", request_id: requestId } },
    { path: "/api/v1/sandbox/steer", body: { id: firstId, text: "change direction" } },
    { path: "/api/v1/sandbox/interrupt", body: { id: firstId } },
    { path: "/api/v1/sandbox/exec", body: { id: firstId, command: "echo ok", timeout_seconds: 30 } },
    { path: "/api/v1/sandbox/stop", body: { id: firstId } },
  ]);
});

test("readSandboxConversation returns 401 JSON when signed out and /events sets private no-store", async () => {
  activeViewer = null;
  const requests = recordFetch(() => {
    throw new Error("Signed-out conversation reads must not query Supabase or the gateway");
  });
  const response = await getSandboxEvents(new Request(`${origin}/api/sandboxes/${firstId}/events`), {
    params: Promise.resolve({ id: firstId }),
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ error: "Sign in again." });
  expect(requests).not.toHaveBeenCalled();
});

test("disconnectGitHub calls POST /api/v1/github/disconnect instead of deleting from Supabase directly", async () => {
  const apiCalls: { path: string; body: unknown }[] = [];
  recordFetch((url, init) => {
    apiCalls.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true });
  });
  expect(await disconnectGitHub()).toEqual({ ok: true, message: "GitHub disconnected." });
  expect(apiCalls).toEqual([{ path: "/api/v1/github/disconnect", body: {} }]);
  expect(revalidatedPaths).toEqual(["/settings"]);
});
