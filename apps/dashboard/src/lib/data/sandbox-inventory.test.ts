import { expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createControlClient } from "../control";
import { parseSandboxFilters, sandboxInventoryScope } from "../sandbox-filters";
import type { Database } from "../supabase/types";
import { loadSandboxInventory, readSandboxMetadata } from "./sandbox-inventory";
import { listSandboxEnrichment } from "./sandboxes";

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
    "working",
    control,
    readSandboxMetadata(supabase, "org", false),
  );
  expect(metadataOffsets).toEqual([0, 500]);
  expect(controlCalls).toEqual(["/api/v1/sandbox/list-turns"]);
  expect(inventory.rows.map(({ id }) => id)).toEqual(["500"]);
});

const inventoryScopeCases: Array<{
  name: string;
  params: Record<string, string | string[] | undefined>;
  activity: "deleted" | undefined;
  statusQuery: string | null;
  expectedDeletedTab: number;
  expectedTotal: number;
  visibleId: string | undefined;
}> = [
  {
    name: "default",
    params: {},
    activity: undefined,
    statusQuery: "neq.deleted",
    expectedDeletedTab: 505,
    expectedTotal: 1,
    visibleId: "0",
  },
  {
    name: "non-deleted status filter",
    params: { status: "ready" },
    activity: undefined,
    statusQuery: "neq.deleted",
    expectedDeletedTab: 0,
    expectedTotal: 1,
    visibleId: "0",
  },
  {
    name: "deleted activity with conflicting status filter",
    params: { status: "ready" },
    activity: "deleted",
    statusQuery: "neq.deleted",
    expectedDeletedTab: 0,
    expectedTotal: 0,
    visibleId: undefined,
  },
  {
    name: "explicit deleted",
    params: { status: "deleted" },
    activity: undefined,
    statusQuery: null,
    expectedDeletedTab: 505,
    expectedTotal: 505,
    visibleId: "1",
  },
  {
    name: "mixed status with deleted",
    params: { status: ["ready", "deleted"] },
    activity: undefined,
    statusQuery: null,
    expectedDeletedTab: 505,
    expectedTotal: 506,
    visibleId: "1",
  },
  {
    name: "deleted activity",
    params: {},
    activity: "deleted",
    statusQuery: null,
    expectedDeletedTab: 505,
    expectedTotal: 505,
    visibleId: "1",
  },
];

test.each(inventoryScopeCases)(
  "$name inventory keeps exact status counts with the expected row scope",
  async ({ params, activity, statusQuery, expectedDeletedTab, expectedTotal, visibleId }) => {
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
      activity,
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
    expect(result.activity).toBe(activity ?? "all");
    expect(result.counts.deleted).toBe(expectedDeletedTab);
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
  expect(result.counts.deleted).toBe(17);
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

test("text search keeps shared inventory active-only and counts matching deleted rows via narrow projection", async () => {
  const rowRequests: URLSearchParams[] = [];
  const deletedSearchRequests: URLSearchParams[] = [];
  const supabase = createClient<Database, "public">("https://metadata.test", "placeholder", {
    global: {
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          expect(url.pathname).toBe("/rest/v1/rpc/sandbox_list_metadata");
          expect(init?.method).not.toBe("HEAD");
          if (url.searchParams.get("status") === "eq.deleted") {
            deletedSearchRequests.push(url.searchParams);
            return Response.json([
              {
                id: "1",
                providerSandboxId: "x".repeat(40),
                displayLabel: "Sandbox 1",
                harness: "codex",
                createdAt: "2026-11-24T00:00:00Z",
              },
              {
                id: "2",
                providerSandboxId: "named-claude",
                displayLabel: "Sandbox 2",
                harness: "claude",
                createdAt: "2026-11-24T00:00:00Z",
              },
            ]);
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
  expect(deletedSearchRequests).toHaveLength(1);
  expect(deletedSearchRequests[0]?.get("select")).toBe("id,providerSandboxId,displayLabel,harness,createdAt");
  expect(deletedSearchRequests[0]?.get("provider")).toBe("in.(modal)");
  expect(result.facets.status.get("deleted")).toBe(1);
  expect(result.counts.deleted).toBe(0);
});

test("one JWT sandbox read enriches only readable rows with cost, host and snapshot", async () => {
  const readable = "10000000-0000-4000-8000-000000000001";
  const restricted = "10000000-0000-4000-8000-000000000002";
  const host = "10000000-0000-4000-8000-000000000003";
  const requests: URL[] = [];
  const supabase = createClient<Database, "public">("https://metadata.test", "placeholder", {
    global: {
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          requests.push(new URL(String(input)));
          return Response.json([
            {
              id: readable,
              harness: "codex",
              credential_id: null,
              usage_turns: [],
              usage_runtime_seconds: 20,
              usage_running_since: null,
              docker_host_id: host,
              goldens: { name: "Nightly" },
            },
          ]);
        },
        { preconnect: fetch.preconnect },
      ),
    },
  });

  const result = await listSandboxEnrichment(supabase, "org", [
    { id: readable, canOpen: true },
    { id: restricted, canOpen: false },
    { id: "malformed", canOpen: true },
  ]);

  expect(requests).toHaveLength(1);
  expect(requests[0]?.pathname).toBe("/rest/v1/sandboxes");
  expect(requests[0]?.searchParams.get("id")).toBe(`in.(${readable})`);
  expect(requests[0]?.searchParams.get("org_id")).toBe("eq.org");
  expect(requests[0]?.searchParams.get("goldens.org_id")).toBe("eq.org");
  expect(requests[0]?.searchParams.get("select")).not.toContain("*");
  expect([...result.keys()]).toEqual([readable]);
  expect(result.get(readable)).toMatchObject({ cost: { computeSeconds: 20 }, hostId: host, snapshot: "Nightly" });
});

test("only sandbox list requests share metadata with the shell, using full inventory only when deleted rows are displayed", () => {
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("status=deleted"))).toBe("all");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("status=ready&status=deleted"))).toBe("all");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("activity=deleted"))).toBe("all");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("activity=deleted&provider=modal"))).toBe("all");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("activity=deleted&status=ready"))).toBe("active");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("status=ready&status=invalid"))).toBe("active");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("owner=me&provider=modal&q=codex"))).toBe("active");
  expect(sandboxInventoryScope("/sandboxes", new URLSearchParams("sort=name&page=2&status=invalid"))).toBe("active");
  expect(sandboxInventoryScope("/sandboxes/sandbox-1", new URLSearchParams())).toBeNull();
  expect(sandboxInventoryScope("/api/fleet/live", new URLSearchParams())).toBeNull();
});
