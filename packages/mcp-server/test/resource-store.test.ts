import { afterAll, beforeAll, expect, test } from "bun:test";
import { machineCapacity, type ProviderResourceObservation, type Sql } from "@armada/core";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import type { Caller } from "../src/caller.ts";
import { createResourceStore, pruneResourceObservations } from "../src/resource-store.ts";

// Synthetic protocol/counter inputs only; these are not measured provider usage.
const now = new Date("2026-11-09T12:00:00Z");
const project = { version: 1, url: "https://github.com/example/web.git", branch: "main", dir: "web" };
const machineSize = {
  version: 1,
  requested: "medium",
  effective: "medium",
  source: "override",
  repositoryDir: "web",
  capacity: machineCapacity("boat", "medium"),
};
let db: Awaited<ReturnType<typeof openDatabase>>;
const sql: Sql = {
  query: (query, params) => db.query(query, params),
  transaction: (work) => db.transaction((tx) => work({ query: (query, params) => tx.query(query, params) })),
};
beforeAll(async () => {
  db = await openDatabase();
  await applyMigrations(db);
});
afterAll(async () => {
  await db.close();
});
async function fixture() {
  const org = crypto.randomUUID(),
    owner = crypto.randomUUID(),
    other = crypto.randomUUID(),
    golden = crypto.randomUUID();
  await db.query("insert into auth.users(id) values($1),($2)", [owner, other]);
  await db.query("insert into public.orgs(id,name) values($1,$2)", [org, `resources-${org}`]);
  await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'member'),($1,$3,'admin')", [
    org,
    owner,
    other,
  ]);
  await db.query(
    `insert into public.goldens(id,org_id,owner_id,name,visibility,config) values($1,$2,$3,'resources','org',$4::jsonb)`,
    [
      golden,
      org,
      owner,
      JSON.stringify({ repos: [{ url: project.url, branch: project.branch, dir: project.dir }], init: [] }),
    ],
  );
  const caller: Caller = { userId: owner, orgs: [{ orgId: org, role: "member" }], via: "service" };
  const store = createResourceStore(sql, caller);
  async function sandbox(
    options: {
      owner?: string;
      visibility?: "org" | "private";
      created?: string;
      project?: unknown;
      size?: unknown;
      model?: string;
      provider?: "boat" | "modal";
      harness?: "claude" | "codex";
    } = {},
  ) {
    const id = crypto.randomUUID();
    await db.query(
      `insert into public.sandboxes(id,golden_id,org_id,owner_id,access_owner_id,visibility,provider,provider_sandbox_id,
      harness,status,model,reasoning_effort,repository_dir,machine_size,resource_project,created_at)
      values($1,$2,$3,$4,$4,$5::public.visibility,$6::public.sandbox_provider,$7,$8::public.harness,'ready',$9,'medium','web',$10::jsonb,$11::jsonb,$12::timestamptz)`,
      [
        id,
        golden,
        org,
        options.owner ?? owner,
        options.visibility ?? "org",
        options.provider ?? "boat",
        `bx_${id}`,
        options.harness ?? "claude",
        options.model ?? "claude-sonnet",
        JSON.stringify(options.size === undefined ? machineSize : options.size),
        JSON.stringify(options.project === undefined ? project : options.project),
        options.created ?? now.toISOString(),
      ],
    );
    return id;
  }
  const reading = (id: string, uptimeMs = 1000, generation = "boot-1"): ProviderResourceObservation => ({
    version: 1,
    providerSandboxId: `bx_${id}`,
    physicalId: `physical-${generation}`,
    generation,
    scope: "dedicated-vm",
    runtimeProvenance: "boat-dedicated-vm",
    reading: {
      version: 1,
      bootId: "00000000-0000-0000-0000-000000000001",
      uptimeMs,
      captureDurationMs: 10,
      cpuLogicalCpus: 4,
      cpuTotalTicks: 1000,
      cpuBusyTicks: 200,
      cpuStealTicks: 0,
      memoryTotalBytes: 8 * 1024 ** 3,
      memoryAvailableBytes: 6 * 1024 ** 3,
      cpuPressureSomeUsec: 0,
      oomKills: 0,
    },
    limitations: ["sampled-memory-not-peak", "hypervisor-throttling-unavailable"],
  });
  async function admit(id: string, at: Date) {
    const token = await store.claim(id, at);
    if (!token) throw Error("Expected resource sampling admission.");
    return token;
  }
  return { org, owner, other, golden, caller, store, sandbox, reading, admit };
}

test("observations persist once per admission and reject chronology, capacity and physical generation conflicts", async () => {
  const f = await fixture(),
    id = await f.sandbox(),
    first = f.reading(id);
  const token = await f.admit(id, now);
  await f.store.append(id, first, now, token);
  await f.store.append(id, first, now, token);
  expect((await f.store.history(id, now)).sessions[0]?.observations).toHaveLength(1);
  await expect(
    f.store.append(id, { ...first, reading: { ...first.reading, cpuBusyTicks: 201 } }, now, token),
  ).rejects.toMatchObject({ code: "conflict" });
  const next = new Date(now.getTime() + 10000),
    nextToken = await f.admit(id, next);
  await expect(f.store.append(id, f.reading(id, 999), next, nextToken)).rejects.toMatchObject({ code: "conflict" });
  await expect(
    f.store.append(
      id,
      { ...f.reading(id, 2000), reading: { ...first.reading, uptimeMs: 2000, cpuLogicalCpus: 8 } },
      next,
      nextToken,
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  await f.store.append(id, f.reading(id, 500, "boot-2"), next, nextToken);
  const third = new Date(now.getTime() + 20000),
    thirdToken = await f.admit(id, third);
  await expect(f.store.append(id, f.reading(id, 3000), third, thirdToken)).rejects.toMatchObject({ code: "conflict" });
  const history = await f.store.history(id, third);
  expect(history.sessions[0]?.observations.map((o) => [o.activity, o.observation.generation])).toEqual([
    ["unknown", "boot-1"],
    ["unknown", "boot-2"],
  ]);
  await expect(
    f.store.append(id, { ...f.reading(id, 600, "boot-2"), providerSandboxId: "other-provider-id" }, third, thirdToken),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    f.store.append(
      id,
      { ...f.reading(id, 600, "boot-2"), runtimeProvenance: "modal-explicit-vm-v1" },
      third,
      thirdToken,
    ),
  ).rejects.toMatchObject({ code: "conflict" });
});

test("last ten comparable launch identities do not widen owner/project/provider/workload/capacity scope", async () => {
  const f = await fixture(),
    matching: string[] = [];
  for (let i = 0; i < 12; i++)
    matching.push(await f.sandbox({ created: new Date(now.getTime() - i * 1000).toISOString() }));
  await f.sandbox({ owner: f.other });
  await f.sandbox({ project: { ...project, url: "https://github.com/example/other.git" } });
  await f.sandbox({ model: "other-model" });
  await f.sandbox({ harness: "codex" });
  // A second provider requires its own golden, so scope segregation is also enforced by schema.
  await f.sandbox({ size: { ...machineSize, capacity: machineCapacity("boat", "large") } });
  const history = await f.store.history(matching[0] ?? "", now);
  expect(history.sessions.map((s) => s.sandbox.id)).toEqual(matching.slice(0, 10));
  expect(history.sessions.every((s) => s.observations.length === 0)).toBe(true);
  const legacy = await f.sandbox({ project: null, size: null });
  expect((await f.store.history(legacy, now)).sessions).toEqual([]);
  // Updating mutable golden configuration never reclassifies an immutable launch project.
  await db.query("update public.goldens set config=$2::jsonb where id=$1", [
    f.golden,
    JSON.stringify({ repos: [{ ...project, url: "https://github.com/example/replaced.git" }], init: [] }),
  ]);
  expect((await f.store.history(matching[0] ?? "", now)).sessions.map((s) => s.sandbox.id)).toEqual(
    matching.slice(0, 10),
  );
  await expect(
    db.query("update public.sandboxes set resource_project='{}'::jsonb where id=$1", [matching[0]]),
  ).rejects.toThrow("immutable");
});

test("current owner/admin interior gates apply to resource SQL regardless legacy visibility; JWTs cannot ingest telemetry", async () => {
  const f = await fixture(),
    privateId = await f.sandbox({ visibility: "private" });
  const other = createResourceStore(sql, { userId: f.other, orgs: [{ orgId: f.org, role: "admin" }], via: "service" });
  expect((await other.history(privateId, now)).target.id).toBe(privateId);
  const adminClaim = await other.claim(privateId, now);
  expect(adminClaim).not.toBeNull();
  await other.append(privateId, f.reading(privateId), now, adminClaim!);
  await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [f.org, f.owner]);
  await db.query("update members set role='member' where org_id=$1 and user_id=$2", [f.org, f.other]);
  await expect(other.history(privateId, now)).rejects.toMatchObject({ code: "not_found" });
  await expect(other.claim(privateId, now)).rejects.toMatchObject({ code: "not_found" });
  await expect(other.append(privateId, f.reading(privateId), now, crypto.randomUUID())).rejects.toMatchObject({
    code: "not_found",
  });
  await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [f.org, f.other]);
  await db.query("delete from public.members where org_id=$1 and user_id=$2", [f.org, f.owner]);
  await expect(f.store.history(privateId, now)).rejects.toMatchObject({ code: "not_found" });
  await expect(f.store.claim(privateId, now)).rejects.toMatchObject({ code: "not_found" });
  await expect(f.store.append(privateId, f.reading(privateId), now, crypto.randomUUID())).rejects.toMatchObject({
    code: "not_found",
  });
  const permissions = await db.query<{
    selectable: boolean;
    insertable: boolean;
  }>(`select has_table_privilege('authenticated','public.resource_observations','select') as selectable,
    has_table_privilege('authenticated','public.resource_observations','insert') as insertable`);
  expect(permissions.rows[0]).toEqual({ selectable: false, insertable: false });
});

test("retention prunes elapsed and excess samples while malformed payloads cannot consume storage", async () => {
  const f = await fixture(),
    id = await f.sandbox();
  const seed = f.reading(id);
  await db.query(
    `insert into public.resource_observations(sandbox_id,physical_id,generation,boot_id,uptime_ms,observed_at,observation,admission_claim_id)
    select $1,$2,$3,$4::uuid,i,$5::timestamptz,$6::jsonb,gen_random_uuid() from generate_series(1,721) i`,
    [id, seed.physicalId, seed.generation, seed.reading.bootId, now.toISOString(), JSON.stringify(seed)],
  );
  await db.query(
    `insert into public.resource_observations(sandbox_id,physical_id,generation,boot_id,uptime_ms,observed_at,observation,admission_claim_id)
    values($1,$2,$3,$4::uuid,722,$5::timestamptz-interval '15 days',$6::jsonb,gen_random_uuid())`,
    [
      id,
      seed.physicalId,
      seed.generation,
      seed.reading.bootId,
      now.toISOString(),
      JSON.stringify({ ...seed, reading: { ...seed.reading, uptimeMs: 722 } }),
    ],
  );
  const token = await f.admit(id, now);
  await f.store.append(id, f.reading(id, 1000), now, token);
  const rows = await db.query<{ count: number; old: number }>(
    `select count(*)::int as count,count(*) filter(where observed_at<$2::timestamptz-interval '14 days')::int as old from public.resource_observations where sandbox_id=$1`,
    [id, now.toISOString()],
  );
  expect(rows.rows[0]).toEqual({ count: 720, old: 0 });
  const invalid = { ...f.reading(id, 2000), reading: { ...seed.reading, uptimeMs: 2000, cpuBusyTicks: -1 } };
  await expect(f.store.append(id, invalid, now, token)).rejects.toMatchObject({ code: "invalid_request" });
  expect((await f.store.history(id, now)).sessions[0]?.observations).toHaveLength(720);
  await pruneResourceObservations(sql, new Date(now.getTime() + 15 * 86400000));
  const expired = await db.query<{ count: number }>(
    "select count(*)::int as count from public.resource_observations where sandbox_id=$1",
    [id],
  );
  expect(expired.rows[0]?.count).toBe(0);
});

test("unknown launch/capacity and arbitrary extra transport fields never become evidence", async () => {
  const f = await fixture();
  const unknown = await f.sandbox({ project: null });
  expect(await f.store.claim(unknown, now)).toBeNull();
  await expect(f.store.append(unknown, f.reading(unknown), now, crypto.randomUUID())).rejects.toMatchObject({
    code: "conflict",
  });
  const id = await f.sandbox();
  const raw = f.reading(id),
    token = await f.admit(id, now);
  await expect(
    f.store.append(id, { ...raw, reading: { ...raw.reading, cpuLogicalCpus: null } }, now, token),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    f.store.append(id, { ...raw, arbitrary: "must not ingest" } as ProviderResourceObservation, now, token),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect((await f.store.history(id, now)).sessions[0]?.observations).toHaveLength(0);
});

test("aggregation excludes actual-capacity mismatches, resets, boot crossings, gaps and stale readings", async () => {
  const { summarizeResourceHistory } = await import("../src/resource-advice.ts");
  const f = await fixture(),
    id = await f.sandbox(),
    other = await f.sandbox();
  const base = f.reading(id);
  await f.store.append(id, base, now, await f.admit(id, now));
  const different = f.reading(other);
  different.reading.cpuLogicalCpus = 8;
  await f.store.append(other, different, now, await f.admit(other, now));
  for (const change of [
    { uptimeMs: 11000, cpuTotalTicks: 900, cpuBusyTicks: 100 },
    { uptimeMs: 41001, cpuTotalTicks: 2000, cpuBusyTicks: 400 },
  ]) {
    const observation = { ...base, reading: { ...base.reading, ...change } };
    const at = new Date(now.getTime() + change.uptimeMs);
    await f.store.append(id, observation, at, await f.admit(id, at));
  }
  const restored = f.reading(id, 1000, "boot-2");
  restored.reading.bootId = "00000000-0000-0000-0000-000000000002";
  const restoredAt = new Date(now.getTime() + 52000);
  await f.store.append(id, restored, restoredAt, await f.admit(id, restoredAt));
  const history = await f.store.history(id, new Date(now.getTime() + 60000));
  const advice = summarizeResourceHistory(history, new Date(now.getTime() + 60000));
  expect(advice.sampled).toMatchObject({ points: 4, intervals: 0, allActivityCpuAverageBusyCores: null });
  expect(advice.window).toMatchObject({ considered: 2, sufficient: 0 });
  expect(advice.recommendedSize).toBeNull();
  expect(summarizeResourceHistory(history, new Date(now.getTime() + 8 * 86400000)).sampled.points).toBe(0);
});

test("sampling admission is atomic, expires, and fences delayed unseen generations and lifecycle changes", async () => {
  const f = await fixture(),
    id = await f.sandbox();
  const concurrent = await Promise.all([f.store.claim(id, now), f.store.claim(id, now)]);
  expect(concurrent.filter((token) => token !== null)).toHaveLength(1);
  const oldToken = concurrent.find((token) => token !== null);
  if (!oldToken) throw Error("Expected one atomic admission.");
  const next = new Date(now.getTime() + 10000),
    newToken = await f.admit(id, next);
  // Old generation was never persisted: only the admission fence can reject its delayed response.
  await f.store.append(id, f.reading(id, 1000, "new-opaque-generation"), next, newToken);
  await expect(
    f.store.append(id, f.reading(id, 9000, "unseen-old-generation"), new Date(now.getTime() + 11000), oldToken),
  ).rejects.toMatchObject({ code: "conflict" });
  const third = new Date(now.getTime() + 20000),
    thirdToken = await f.admit(id, third);
  await f.store.append(id, f.reading(id, 2000, "new-opaque-generation"), third, thirdToken);
  const changedAt = new Date(now.getTime() + 30000),
    changedToken = await f.admit(id, changedAt);
  await db.query("update public.sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]);
  await expect(
    f.store.append(id, f.reading(id, 3000, "new-opaque-generation"), changedAt, changedToken),
  ).rejects.toMatchObject({ code: "conflict" });
  const expiredAt = new Date(now.getTime() + 40000),
    expiringToken = await f.admit(id, expiredAt);
  await expect(
    f.store.append(id, f.reading(id, 4000, "new-opaque-generation"), new Date(now.getTime() + 50000), expiringToken),
  ).rejects.toMatchObject({ code: "conflict" });
  const history = await f.store.history(id, new Date(now.getTime() + 60000));
  expect(history.sessions[0]?.observations.map((o) => o.observation.generation)).toEqual([
    "new-opaque-generation",
    "new-opaque-generation",
  ]);
  expect(history.sessions[0]?.observations.map((o) => o.observation.reading.uptimeMs)).toEqual([1000, 2000]);
});

test("sampling does not admit or persist while a lifecycle operation owns the sandbox", async () => {
  const f = await fixture(),
    id = await f.sandbox();
  await db.query("update public.sandboxes set activity_until=$2::timestamptz where id=$1", [
    id,
    new Date(now.getTime() + 10000).toISOString(),
  ]);
  expect(await f.store.claim(id, now)).toBeNull();
  await db.query("update public.sandboxes set activity_until=null where id=$1", [id]);
  const token = await f.admit(id, now);
  await db.query("update public.sandboxes set reconcile_lease_until=$2::timestamptz where id=$1", [
    id,
    new Date(now.getTime() + 10000).toISOString(),
  ]);
  await expect(f.store.append(id, f.reading(id), now, token)).rejects.toMatchObject({ code: "conflict" });
  expect((await f.store.history(id, now)).sessions[0]?.observations).toHaveLength(0);
});

test("normal resource history and admission exclude managed orchestrator parents", async () => {
  const f = await fixture();
  const ordinary = await f.sandbox({ visibility: "private" }),
    parent = await f.sandbox({ visibility: "private" });
  await db.query("insert into public.orchestrators(org_id,owner_id,sandbox_id) values($1,$2,$3)", [
    f.org,
    f.owner,
    parent,
  ]);
  await expect(f.store.history(parent, now)).rejects.toMatchObject({ code: "not_found" });
  await expect(f.store.claim(parent, now)).rejects.toMatchObject({ code: "not_found" });
  expect((await f.store.history(ordinary, now)).sessions.map((s) => s.sandbox.id)).toEqual([ordinary]);
});
