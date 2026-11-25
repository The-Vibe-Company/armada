import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import SandboxPage from "@/app/(app)/sandboxes/[id]/page";
import { type ModelAccount, parseAccount } from "@/lib/model-accounts";
import type { Database } from "@/lib/supabase/types";
import { listSelectedAccounts, readConnectionTestChoices } from "./model-accounts";

const viewer = { id: "owner", email: "owner@example.test", token: "viewer" };
const selected = { org: { id: "org", name: "Org" }, role: "admin" };
const origin = "https://dashboard.test";
const timestamp = "2026-11-01T00:00:00Z";
const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
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

mock.module("./viewer", () => ({
  requireViewer: async () => viewer,
  listMemberships: async () => [selected],
  memberDirectory: async () => new Map(),
  displayUser: () => "You",
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

function recordFetch(reply: (url: URL) => Response | Promise<Response>) {
  const fetchResponse = async (input: Parameters<typeof fetch>[0]) =>
    reply(new URL(input instanceof Request ? input.url : String(input)));
  const fetchFixture = Object.assign(fetchResponse, { preconnect: fetch.preconnect });
  // oxlint-disable-next-line landmines-testing/no-test-doubles -- Feed both real clients HTTP responses and hold the credential response without sockets or timers.
  return spyOn(globalThis, "fetch").mockImplementation(fetchFixture);
}

afterEach(() => mock.restore());

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

test.each(["starting", "running", "stopping"] as const)(
  "sandbox detail skips account choices while %s",
  async (status) => {
    const requests = recordFetch((url) => {
      switch (url.pathname) {
        case "/rest/v1/sandboxes":
          return Response.json([
            {
              id: firstId,
              owner_id: viewer.id,
              org_id: selected.org.id,
              provider: "modal",
              golden_id: secondId,
              credential_id: null,
              conversation_ids: [],
              harness: "codex",
              status,
              created_at: timestamp,
            },
          ]);
        case "/rest/v1/rpc/sandbox_detail_status":
          return Response.json(status);
        case "/rest/v1/goldens":
        case "/rest/v1/sandbox_launch_stages":
          return Response.json([]);
        case "/api/v1/mcp/sandbox-connections":
          return Response.json({ connections: [] });
        case "/api/v1/creds/list":
          return Response.json({ user: [] });
        default:
          throw new Error(`Unexpected request ${url.pathname}`);
      }
    });

    expect(await SandboxPage({ params: Promise.resolve({ id: firstId }) })).toBeTruthy();
    expect(requests.mock.calls.map(([input]) => String(input))).not.toContain(`${origin}/api/v1/creds/list`);
  },
);
