import { expect, test } from "bun:test";
import { cacheOttoRepositoryAccess, createOttoApi } from "../src/otto/api.ts";

test("Otto API rejects unauthenticated and out-of-scope reads before querying SQL", async () => {
  let queries = 0;
  const sql = {
    async query() {
      queries++;
      throw Error("Authorization must precede SQL");
    },
  };
  const scope = { orgId: "org", repository: "example/web" };
  const caller = { userId: "member", orgs: [{ orgId: "org", role: "member" as const }], via: "service" as const };
  for (const scenario of [
    { authenticated: false, org: "org", repository: "example/web", expected: 401 },
    { authenticated: true, org: "other-org", repository: "example/web", expected: 404 },
    { authenticated: true, org: "org", repository: "other/repository", expected: 404 },
  ]) {
    const api = createOttoApi(sql, scope, async () => (scenario.authenticated ? { ok: true, caller } : { ok: false }));
    const response = await api(
      new Request(
        `https://armada.example/api/v1/otto/resources?org_id=${scenario.org}&repository=${scenario.repository}`,
      ),
    );
    expect(response?.status).toBe(scenario.expected);
  }
  expect(queries).toBe(0);
});

test("every Otto view has a deadline and logs only view and elapsed time", async () => {
  const { spyOn } = await import("bun:test");
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    queueMicrotask(callback);
    return 0;
  }) as unknown as typeof setTimeout);
  const log = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const api = createOttoApi(
      { query: () => new Promise(() => {}) },
      { orgId: "org", repository: "example/web" },
      async () => ({
        ok: true,
        caller: { userId: "user", orgs: [{ orgId: "org", role: "admin" }], via: "service" },
      }),
    );
    for (const view of ["summary", "tasks", "resources", "orphans", "facts"]) {
      const response = await api(new Request(`https://armada.example/api/v1/otto/${view}?org_id=org`));
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({ completeness: "unknown", fleetCompleteness: "unknown" });
      expect(log.mock.calls.at(-1)?.[0]).toMatch(new RegExp(`^Otto read unavailable view=${view} elapsed_ms=\\d+$`));
    }
    expect(log).toHaveBeenCalledTimes(5);
  } finally {
    schedule.mockRestore();
    log.mockRestore();
  }
});

test("Otto selects only bound repositories, binds fact cursors and denies removed connected access", async () => {
  const scopes = ["example/web", "example/skills"].map((repository) => ({ orgId: "org", repository }));
  const caller = { userId: "member", orgs: [{ orgId: "org", role: "member" as const }], via: "service" as const };
  let allowed = true;
  let clock = 0;
  const queried: unknown[][] = [];
  const api = createOttoApi(
    {
      async query(_text, params) {
        queried.push(params ?? []);
        return {
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000001",
              observed_at: "2026-11-14T00:00:00Z",
              repository: params?.[1],
            },
            {
              id: "00000000-0000-0000-0000-000000000002",
              observed_at: "2026-11-13T00:00:00Z",
              repository: params?.[1],
            },
          ],
        } as never;
      },
    },
    scopes,
    async () => ({ ok: true, caller }),
    () => new Date(clock),
    undefined,
    async () => allowed,
  );
  const get = (view: string, repository = "example/web", cursor = "") =>
    api(
      new Request(
        `https://armada.example/api/v1/otto/${view}?org_id=org&repository=${repository}&limit=1&cursor=${cursor}`,
      ),
    );
  const list = (await (await get("repositories"))?.json()) as { items: string[] };
  expect(list.items).toEqual(["example/web", "example/skills"]);
  const web = (await (await get("facts"))?.json()) as { items: { repository: string }[]; nextCursor: string };
  expect(web.items[0]?.repository).toBe("example/web");
  expect((await get("facts", "example/skills", web.nextCursor))?.status).toBe(400);
  expect((await get("facts", "example/skills"))?.status).toBe(200);
  expect(queried.map((params) => params[1])).toEqual(["example/web", "example/skills"]);
  allowed = false;
  clock += 60_000;
  expect((await get("facts"))?.status).toBe(503);
  expect(queried).toHaveLength(2);
});

test("repository access decisions coalesce concurrent views, isolate users/repos, expire and retry failures", async () => {
  const caller = { userId: "member", orgs: [], via: "service" as const };
  let clock = 0,
    calls = 0,
    allowed = true,
    fail = false;
  const check = cacheOttoRepositoryAccess(
    async () => {
      calls++;
      if (fail) throw Error("unavailable");
      return allowed;
    },
    () => clock,
  );
  expect(await Promise.all(Array.from({ length: 5 }, () => check(caller, "example/web")))).toEqual(Array(5).fill(true));
  expect(calls).toBe(1);
  await check({ ...caller, userId: "other" }, "example/web");
  await check(caller, "example/skills");
  expect(calls).toBe(3);
  allowed = false;
  clock = 59_999;
  expect(await check(caller, "example/web")).toBe(true);
  clock = 60_000;
  expect(await check(caller, "example/web")).toBe(false);
  clock += 60_000;
  fail = true;
  await expect(check(caller, "example/web")).rejects.toThrow("unavailable");
  fail = false;
  expect(await check(caller, "example/web")).toBe(false);
  expect(calls).toBe(6);
});

test("repository discovery isolates a denied repository from healthy observation reads", async () => {
  const scope = { orgId: "org_one", repository: "owner/healthy" };
  const route = createOttoApi(
    { query: async () => ({ rows: [] }) },
    [scope, { ...scope, repository: "owner/unavailable" }],
    async () => ({
      ok: true,
      caller: { userId: "user_one", orgs: [{ orgId: scope.orgId, role: "member" }], via: "supabase" },
    }),
    undefined,
    undefined,
    async (_caller, repository) => {
      if (repository.endsWith("unavailable")) throw Error("access unavailable");
      return true;
    },
  );
  const listing = await route(new Request(`https://armada.test/api/v1/otto/repositories?org_id=${scope.orgId}`));
  expect((await listing!.json()).items).toEqual([scope.repository]);
  const facts = await route(
    new Request(`https://armada.test/api/v1/otto/facts?org_id=${scope.orgId}&repository=${scope.repository}`),
  );
  expect(facts?.status).toBe(200);
});
