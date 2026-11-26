import { expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createControlClient } from "../control";
import { canPushDownDeletedSearch, parseSandboxFilters, sandboxInventoryScope } from "../sandbox-filters";
import type { Database } from "../supabase/types";
import { loadSandboxInventory, readSandboxMetadata } from "./sandbox-inventory";
import { listSandboxEnrichment } from "./sandboxes";
import { memberDirectory } from "./viewer";

function sandbox(index: number, status = "ready") {
  return {
    id: String(index),
    orgId: "org",
    ownerId: "viewer",
    provider: "modal",
    providerSandboxId: null,
    harness: "codex",
    model: null,
    reasoningEffort: null,
    status,
    createdAt: "2026-11-23T00:00:00Z",
    stoppedAt: null,
    expiresAt: null,
    effectiveTtlSeconds: null,
    machineSize: null,
    displayLabel: `Sandbox ${index}`,
    canOpen: true,
    canManage: true,
  };
}

test("the Sandboxes list reads activity once for the organization without per-sandbox controls", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => sandbox(index));
  const metadataOffsets: number[] = [];
  const supabase = createClient<Database, "public">("https://metadata.test", "placeholder", {
    global: {
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          expect(url.pathname).toBe("/rest/v1/rpc/sandbox_list_metadata");
          if (init?.method === "HEAD") {
            expect(url.searchParams.get("status")).toBe("eq.deleted");
            return new Response(null, { headers: { "content-range": "*/0" } });
          }
          expect(url.searchParams.get("status")).toBe("neq.deleted");
          const offset = Number(url.searchParams.get("offset"));
          metadataOffsets.push(offset);
          return Response.json(rows.slice(offset, offset + 500));
        },
        { preconnect: fetch.preconnect },
      ),
    },
  });
  const controlCalls: string[] = [];
  const control = createControlClient({
    serverUrl: "https://armada.test",
    token: "placeholder",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        controlCalls.push(new URL(String(input)).pathname);
        expect(JSON.parse(String(init?.body))).toEqual({ org: "org" });
        return Response.json({ "500": "running" });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const inventory = await loadSandboxInventory(
    supabase,
    "org",
    parseSandboxFilters({ status: "ready" }),
    "viewer",
    "active",
    control,
    readSandboxMetadata(supabase, "org", false),
  );
  expect(metadataOffsets).toEqual([0, 500]);
  expect(controlCalls).toEqual(["/api/v1/sandbox/list-turns"]);
  expect([...inventory.workingIds]).toEqual(["500"]);
  expect(inventory.counts.active).toBe(501);
});

const inventoryScopeCases: Array<{
  name: string;
  params: Record<string, string | string[] | undefined>;
  statusQuery: string | null;
  expectedTotal: number;
  visibleId: string | undefined;
}> = [
  {
    name: "default",
    params: {},
    statusQuery: "neq.deleted",
    expectedTotal: 1,
    visibleId: "0",
  },
  {
    name: "non-deleted status filter",
    params: { status: "ready" },
    statusQuery: "neq.deleted",
    expectedTotal: 1,
    visibleId: "0",
  },
  {
    name: "explicit deleted",
    params: { status: "deleted" },
    statusQuery: null,
    expectedTotal: 505,
    visibleId: "1",
  },
  {
    name: "mixed status with deleted",
    params: { status: ["ready", "deleted"] },
    statusQuery: null,
    expectedTotal: 506,
    visibleId: "1",
  },
];

test.each(inventoryScopeCases)(
  "$name inventory keeps exact status counts with the expected row scope",
  async ({ params, statusQuery, expectedTotal, visibleId }) => {
    const deleted = 505;
    const active = sandbox(0);
    const history = Array.from({ length: deleted }, (_, index) => ({
      ...sandbox(index + 1, "deleted"),
      createdAt: "2026-11-24T00:00:00Z",
    }));
    const rowReads: Array<{ offset: number; status: string | null }> = [];
    const countReads: string[] = [];
    const supabase = createClient<Database, "public">("https://metadata.test", "placeholder", {
      global: {
        fetch: Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            expect(url.pathname).toBe("/rest/v1/rpc/sandbox_list_metadata");
            expect(url.searchParams.get("orgId")).toBe("eq.org");
            const status = url.searchParams.get("status");
            if (init?.method === "HEAD") {
              expect(new Headers(init.headers).get("prefer")).toContain("count=exact");
              countReads.push(String(status));
              return new Response(null, { headers: { "content-range": `*/${deleted}` } });
            }
            const offset = Number(url.searchParams.get("offset"));
            const limit = Number(url.searchParams.get("limit"));
            rowReads.push({ status, offset });
            const rows = status === "neq.deleted" ? [active] : [active, ...history];
            return Response.json(rows.slice(offset, offset + limit));
          },
          { preconnect: fetch.preconnect },
        ),
      },
    });

    const result = await loadSandboxInventory(
      supabase,
      "org",
      parseSandboxFilters(params),
      "viewer",
      undefined,
      null,
      readSandboxMetadata(supabase, "org", !statusQuery),
    );

    expect(rowReads).toEqual(
      statusQuery
        ? [{ offset: 0, status: statusQuery }]
        : [
            { offset: 0, status: null },
            { offset: 500, status: null },
          ],
    );
    expect(countReads).toEqual(statusQuery ? ["eq.deleted"] : []);
    expect(result.activity).toBe("all");
    expect(result.total).toBe(expectedTotal);
    expect(result.rows[0]?.id).toBe(visibleId);
    expect(result.facets.status.get("deleted")).toBe(deleted);
    expect(result.facets.status.get("ready")).toBe(1);
  },
);

test("structured facet filters count deleted sandboxes via HEAD without downloading deleted rows", async () => {
  const otherOwner = "00000000-0000-4000-8000-000000000009";
  const headParams: URLSearchParams[] = [];
  const rowStatuses: Array<string | null> = [];
  const supabase = createClient<Database, "public">("https://metadata.test", "placeholder", {
    global: {
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          expect(url.pathname).toBe("/rest/v1/rpc/sandbox_list_metadata");
          if (init?.method === "HEAD") {
            headParams.push(url.searchParams);
            return new Response(null, { headers: { "content-range": "*/17" } });
          }
          rowStatuses.push(url.searchParams.get("status"));
          return Response.json([sandbox(0)]);
        },
        { preconnect: fetch.preconnect },
      ),
    },
  });

  const result = await loadSandboxInventory(
    supabase,
    "org",
    parseSandboxFilters({
      provider: "modal",
      harness: "codex",
      owner: ["me", otherOwner],
      size: ["unknown", "large"],
      model: ["unknown", 'gpt-5.4, "beta"\\1'],
    }),
    "viewer",
    undefined,
    null,
    readSandboxMetadata(supabase, "org", false),
  );

  expect(rowStatuses).toEqual(["neq.deleted"]);
  expect(headParams).toHaveLength(1);
  expect(headParams[0]?.get("status")).toBe("eq.deleted");
  expect(headParams[0]?.get("provider")).toBe("in.(modal)");
  expect(headParams[0]?.get("harness")).toBe("in.(codex)");
  expect(headParams[0]?.get("ownerId")).toBe(`in.(viewer,${otherOwner})`);
  expect(headParams[0]?.getAll("or")).toEqual([
    "(machineSize.is.null,machineSize.in.(large))",
    '(model.is.null,model.in.("unknown","gpt-5.4, \\"beta\\"\\\\1"))',
  ]);
  expect(result.facets.status.get("deleted")).toBe(17);

  const second = await loadSandboxInventory(
    supabase,
    "org",
    parseSandboxFilters({ size: "unknown", model: "null" }),
    "viewer",
    undefined,
    null,
    readSandboxMetadata(supabase, "org", false),
  );
  expect(headParams).toHaveLength(2);
  expect(headParams[1]?.get("machineSize")).toBe("is.null");
  expect(headParams[1]?.get("model")).toBe('in.("null")');
  expect(second.facets.status.get("deleted")).toBe(17);
});

test("non-fallback text search counts deleted sandboxes via HEAD without downloading deleted rows", async () => {
  const headParams: URLSearchParams[] = [];
  const rowStatuses: Array<string | null> = [];
  const supabase = createClient<Database, "public">("https://metadata.test", "placeholder", {
    global: {
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          expect(url.pathname).toBe("/rest/v1/rpc/sandbox_list_metadata");
          if (init?.method === "HEAD") {
            headParams.push(url.searchParams);
            return new Response(null, { headers: { "content-range": "*/4" } });
          }
          rowStatuses.push(url.searchParams.get("status"));
          return Response.json([sandbox(0)]);
        },
        { preconnect: fetch.preconnect },
      ),
    },
  });

  const result = await loadSandboxInventory(
    supabase,
    "org",
    parseSandboxFilters({ q: "bx_worker-42", provider: "modal" }),
    "viewer",
    undefined,
    null,
    readSandboxMetadata(supabase, "org", false),
  );

  expect(rowStatuses).toEqual(["neq.deleted"]);
  expect(headParams).toHaveLength(1);
  expect(headParams[0]?.get("status")).toBe("eq.deleted");
  expect(headParams[0]?.get("provider")).toBe("in.(modal)");
  expect(headParams[0]?.getAll("or")).toEqual([
    "(displayLabel.ilike.*bx\\_worker-42*,providerSandboxId.ilike.*bx\\_worker-42*)",
  ]);
  expect(result.facets.status.get("deleted")).toBe(4);
});

test("fallback-matching text search keeps shared inventory active-only and pages narrow deleted rows cleanly", async () => {
  const rowRequests: URLSearchParams[] = [];
  const deletedSearchRequests: Array<{ offset: number; select: string | null; provider: string | null }> = [];
  const pageOne = Array.from({ length: 500 }, (_, index) => ({
    id: `row-${index}`,
    providerSandboxId: index === 0 ? "x".repeat(40) : "named-claude",
    displayLabel: `Sandbox row-${index}`,
    harness: index === 0 ? "codex" : "claude",
    createdAt: "2026-11-24T00:00:00Z",
  }));
  pageOne[1] = {
    id: "malformed",
    providerSandboxId: "",
    displayLabel: "Sandbox malformed",
    harness: "codex",
    createdAt: "2026-11-24T00:00:00Z",
  };
  const supabase = createClient<Database, "public">("https://metadata.test", "placeholder", {
    global: {
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          expect(url.pathname).toBe("/rest/v1/rpc/sandbox_list_metadata");
          expect(init?.method).not.toBe("HEAD");
          if (url.searchParams.get("status") === "eq.deleted") {
            const offset = Number(url.searchParams.get("offset"));
            deletedSearchRequests.push({
              offset,
              select: url.searchParams.get("select"),
              provider: url.searchParams.get("provider"),
            });
            if (offset >= 500) {
              return Response.json(
                { code: "PGRST103", message: "Requested range not satisfiable", details: null, hint: null },
                { status: 416 },
              );
            }
            return Response.json(pageOne);
          }
          rowRequests.push(url.searchParams);
          return Response.json([sandbox(0)]);
        },
        { preconnect: fetch.preconnect },
      ),
    },
  });

  const result = await loadSandboxInventory(
    supabase,
    "org",
    parseSandboxFilters({ q: "Codex sandbox", provider: "modal", status: "ready" }),
    "viewer",
    undefined,
    null,
    readSandboxMetadata(supabase, "org", false),
  );

  expect(rowRequests).toHaveLength(1);
  expect(rowRequests[0]?.get("status")).toBe("neq.deleted");
  expect(deletedSearchRequests).toEqual([
    { offset: 0, select: "id,providerSandboxId,displayLabel,harness,createdAt", provider: "in.(modal)" },
    { offset: 500, select: "id,providerSandboxId,displayLabel,harness,createdAt", provider: "in.(modal)" },
  ]);
  expect(result.facets.status.get("deleted")).toBe(1);
});

test("listSandboxEnrichment reads readable rows and credential kinds in parallel without a serial round-trip", async () => {
  const readable = "10000000-0000-4000-8000-000000000001";
  const restricted = "10000000-0000-4000-8000-000000000002";
  const host = "10000000-0000-4000-8000-000000000003";
  const credentialId = "10000000-0000-4000-8000-000000000004";
  const requests: URL[] = [];
  const sandboxReply = Promise.withResolvers<Response>();
  const credentialsStarted = Promise.withResolvers<void>();
  const supabase = createClient<Database, "public">("https://metadata.test", "placeholder", {
    global: {
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          requests.push(url);
          if (url.pathname === "/rest/v1/sandboxes") return sandboxReply.promise;
          if (url.pathname === "/rest/v1/credentials") {
            credentialsStarted.resolve();
            return Response.json([{ id: credentialId, kind: "openai" }]);
          }
          throw new Error(`Unexpected request ${url.pathname}`);
        },
        { preconnect: fetch.preconnect },
      ),
    },
  });

  const pending = listSandboxEnrichment(supabase, "org", [
    { id: readable, canOpen: true },
    { id: restricted, canOpen: false },
    { id: "malformed", canOpen: true },
  ]);

  await credentialsStarted.promise;
  expect(requests.map((url) => url.pathname)).toEqual(["/rest/v1/sandboxes", "/rest/v1/credentials"]);

  sandboxReply.resolve(
    Response.json([
      {
        id: readable,
        harness: "codex",
        credential_id: credentialId,
        usage_turns: [],
        usage_runtime_seconds: 20,
        usage_running_since: null,
        docker_host_id: host,
        goldens: { name: "Nightly" },
      },
    ]),
  );
  const result = await pending;

  expect(requests).toHaveLength(2);
  expect(requests[0]?.pathname).toBe("/rest/v1/sandboxes");
  expect(requests[0]?.searchParams.get("id")).toBe(`in.(${readable})`);
  expect(requests[0]?.searchParams.get("org_id")).toBe("eq.org");
  expect(requests[0]?.searchParams.get("goldens.org_id")).toBe("eq.org");
  expect(requests[0]?.searchParams.get("select")).not.toContain("*");
  expect(requests[1]?.pathname).toBe("/rest/v1/credentials");
  expect(requests[1]?.searchParams.get("select")).toBe("id,kind");
  expect([...result.keys()]).toEqual([readable]);
  expect(result.get(readable)).toMatchObject({
    cost: { computeSeconds: 20, basis: "estimated" },
    hostId: host,
    snapshot: "Nightly",
  });
});

test("memberDirectory deduplicates org_members RPC reads for repeated org ids", async () => {
  const calls: string[] = [];
  const supabase = createClient<Database, "public">("https://metadata.test", "placeholder", {
    global: {
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          expect(url.pathname).toBe("/rest/v1/rpc/org_members");
          const body = JSON.parse(String(init?.body)) as { target_org: string };
          calls.push(body.target_org);
          return Response.json([{ user_id: "u-1", email: "alice@example.com" }]);
        },
        { preconnect: fetch.preconnect },
      ),
    },
  });

  const directory = await memberDirectory(supabase, ["org-1", "org-1"]);
  expect(directory.get("u-1")).toBe("alice@example.com");
  expect(calls).toEqual(["org-1"]);
});

test("only sandbox list requests share metadata with the shell, using full inventory only when deleted rows are displayed", () => {
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("status=deleted"))).toBe("all");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("status=ready&status=deleted"))).toBe("all");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("activity=deleted"))).toBe("active");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("activity=active&provider=modal"))).toBe("active");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("status=ready&status=invalid"))).toBe("active");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("owner=me&provider=modal&q=codex"))).toBe("active");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("sort=name&page=2&status=invalid"))).toBe("active");
  expect(sandboxInventoryScope("/sandboxes/sandbox-1", new URLSearchParams())).toBeNull();
  expect(sandboxInventoryScope("/api/fleet/live", new URLSearchParams())).toBeNull();
  expect(canPushDownDeletedSearch("bx_worker-42")).toBe(true);
  expect(canPushDownDeletedSearch("00000000-0000-4000-8000-000000000001")).toBe(true);
  expect(canPushDownDeletedSearch("Codex sandbox")).toBe(false);
  expect(canPushDownDeletedSearch("Nov 24")).toBe(false);
  expect(canPushDownDeletedSearch("v1.2")).toBe(false);
});
