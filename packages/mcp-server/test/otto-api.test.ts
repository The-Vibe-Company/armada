import { expect, test } from "bun:test";
import { createOttoApi } from "../src/otto/api.ts";

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
