import { expect, test } from "bun:test";
import { applyPlan, type CleanupApi, inventory, type RetirementPlan } from "./retire-orchestrators.ts";

const parent = { id: "parent", ownerId: "owner", orgId: "org", revision: 7, state: "ready" };
test("retirement inventory paginates and checks linked children without retaining prompt payloads", async () => {
  const requests: string[] = [];
  const api: CleanupApi = async (_method, path) => {
    requests.push(path);
    if (path === "/account/status") return { userId: "owner" };
    if (path.startsWith("/orchestrators?"))
      return path.includes("cursor=next") ? { items: [], cursor: null } : { items: [{ id: "parent" }], cursor: "next" };
    if (path.startsWith("/orchestrators/parent?"))
      return {
        orchestrator: { ...parent, configuration: { text: "private prompt" } },
        childSandboxIds: ["child"],
        operations: [],
      };
    if (path === "/sandbox/detail") return { id: "child", status: "running" };
    throw Error("Unexpected route");
  };
  const plan = await inventory(api, "https://armada.test", "owner", "org");
  expect(requests.some((path) => path.includes("cursor=next"))).toBe(true);
  expect(plan.children).toEqual([{ id: "child", status: "running" }]);
  expect(plan.stops.map((stop) => stop.kind)).toEqual(["child", "parent"]);
  expect(JSON.stringify(plan)).not.toContain("private prompt");
});

test("unknown stop keeps its pre-dispatch key/revision and apply never replays it", async () => {
  const plan: RetirementPlan = {
    version: 1,
    origin: "https://armada.test",
    owner: "owner",
    org: "org",
    createdAt: "now",
    parents: [{ orchestrator: parent, childSandboxIds: [], operations: [] }],
    children: [],
    stops: [{ id: "parent", kind: "parent", revision: 7, key: "fixed-key", state: "planned" }],
  };
  let dispatches = 0;
  const saved: string[] = [];
  const api: CleanupApi = async (_method, path, body, key) => {
    if (path === "/account/status") return { userId: "owner" };
    dispatches++;
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0]!).stops[0]).toMatchObject({ state: "dispatched", revision: 7, key: "fixed-key" });
    expect(body).toEqual({ orgId: "org", expectedRevision: 7 });
    expect(key).toBe("fixed-key");
    throw Error("Outcome unknown");
  };
  await expect(
    applyPlan(api, plan, async () => {
      saved.push(JSON.stringify(plan));
    }),
  ).rejects.toThrow("Outcome unknown");
  await expect(applyPlan(api, plan, async () => {})).rejects.toThrow("Outcome unknown");
  expect(dispatches).toBe(1);
});

test("pending receipt polling retains its identity and never repeats stop dispatch", async () => {
  const plan: RetirementPlan = {
    version: 1,
    origin: "https://armada.test",
    owner: "owner",
    org: "org",
    createdAt: "now",
    parents: [{ orchestrator: parent, childSandboxIds: [], operations: [] }],
    children: [],
    stops: [{ id: "parent", kind: "parent", revision: 7, key: "stable", state: "planned" }],
  };
  let dispatches = 0,
    polls = 0;
  const api: CleanupApi = async (_method, path) => {
    if (path === "/account/status") return { userId: "owner" };
    if (path.endsWith("/stop")) {
      dispatches++;
      return { id: "receipt" };
    }
    polls++;
    return { orchestrator: parent, operations: [{ id: "receipt", state: "pending" }] };
  };
  for (let retry = 0; retry < 2; retry++)
    await expect(applyPlan(api, plan, async () => {})).rejects.toThrow("Stop is pending");
  expect(dispatches).toBe(1);
  expect(polls).toBe(200);
  expect(plan.stops[0]).toMatchObject({ key: "stable", operationId: "receipt", state: "dispatched" });
});

test("dry-run lists blocked parents and children while apply refuses before any writes or HTTP mutation", async () => {
  const operations = [
    { id: "pending-receipt", state: "pending" },
    { id: "unknown-receipt", state: "uncertain" },
  ];
  const api: CleanupApi = async (_method, path) => {
    if (path === "/account/status") return { userId: "owner" };
    if (path.startsWith("/orchestrators?")) return { items: [{ id: "parent" }], cursor: null };
    if (path.startsWith("/orchestrators/parent?"))
      return { orchestrator: { ...parent, state: "blocked" }, childSandboxIds: ["child"], operations };
    if (path === "/sandbox/detail") return { id: "child", status: "running" };
    throw Error("Unexpected route");
  };
  const plan = await inventory(api, "https://armada.test", "owner", "org");
  expect(plan.parents[0]?.orchestrator.state).toBe("blocked");
  expect(plan.parents[0]?.operations).toEqual(operations);
  expect(plan.children).toEqual([{ id: "child", status: "running" }]);
  const before = JSON.stringify(plan);
  let calls = 0,
    writes = 0;
  await expect(
    applyPlan(
      async () => {
        calls++;
        throw Error("Must not call API");
      },
      plan,
      async () => {
        writes++;
      },
    ),
  ).rejects.toThrow("pending/uncertain");
  expect({ calls, writes }).toEqual({ calls: 0, writes: 0 });
  expect(JSON.stringify(plan)).toBe(before);
});
