import { expect, test } from "bun:test";
import { SQL } from "bun";
import { GoldenBuildJobs } from "../src/golden-build-jobs.ts";
import type { GoldenConfig } from "../src/golden-config.ts";
import type { Sql } from "../src/golden-store.ts";
import { createSqlGoldenStore } from "../src/golden-store.ts";
import type { Provider } from "../src/provider.ts";

// Dedicated disposable database with migrations applied, never a production URL.
const url = process.env.ARMADA_TEST_POSTGRES_URL;
test.skipIf(!url)("PostgreSQL serializes durable admission and fences a crashed claim across workers", async () => {
  const a = new SQL(url!, { max: 2 });
  const b = new SQL(url!, { max: 2 });
  const adapt = (client: Pick<SQL, "unsafe">): Sql => ({
    query: async <T>(query: string, params: unknown[] = []) => ({
      rows: Array.from(await client.unsafe(query, params as never[])) as T[],
    }),
  });
  const sqlA: Sql = { ...adapt(a), transaction: (work) => a.begin((tx) => work(adapt(tx))) };
  const sqlB: Sql = { ...adapt(b), transaction: (work) => b.begin((tx) => work(adapt(tx))) };
  const owner = crypto.randomUUID(),
    org = crypto.randomUUID();
  const actor = { userId: owner, orgId: org, role: "admin" as const };
  const provider = {
    id: "boat",
    maxGoldens: 1,
    backendIdentity: async () => ({ id: "async-job-account" }),
  } as Provider;
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let resolutions = 0;
  const options = {
    encryptionKey: Buffer.alloc(32, 31).toString("base64"),
    service: { github: { store: {} as never, encryptionKey: undefined, app: null }, installationApp: null },
    provider: async () => {
      resolutions++;
      entered();
      await gate;
      return provider;
    },
  };
  const jobsA = new GoldenBuildJobs({ ...options, sql: sqlA });
  const jobsB = new GoldenBuildJobs({ ...options, sql: sqlB });
  let running: Promise<boolean> | undefined;
  try {
    await a.unsafe("insert into auth.users(id) values($1)", [owner]);
    await a.unsafe("insert into orgs(id,name) values($1,$2)", [org, "async-jobs-" + org]);
    await a.unsafe("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, owner]);
    const key = crypto.randomUUID();
    const input = { name: "async-job", visibility: "org" as const, repos: ["acme/web"] };
    const [one, replay] = await Promise.all([
      jobsA.admit(provider, actor, input, key),
      jobsB.admit(provider, actor, input, key),
    ]);
    expect(one.jobId).toBe(replay.jobId);
    expect((await a.unsafe("select 1 from golden_build_jobs where org_id=$1", [org])).length).toBe(1);
    await expect(jobsB.admit(provider, actor, input, crypto.randomUUID())).rejects.toMatchObject({ code: "conflict" });
    running = jobsA.runOne();
    await started;
    expect(await jobsB.runOne()).toBe(false);
    expect(resolutions).toBe(1);
    await b.unsafe("update golden_build_jobs set lease_until=now()-interval '1 second' where id=$1", [one.jobId]);
    expect(await jobsB.runOne()).toBe(false);
    resume();
    await running;
    expect((await jobsB.status(owner, one.jobId)).state).toBe("recovery_required");
    expect(resolutions).toBe(1); // No automatic provider/build replay after the lease expired.
    expect((await a.unsafe("select 1 from golden_backend_slots where org_id=$1", [org])).length).toBe(1);
    expect((await a.unsafe("select 1 from goldens where org_id=$1", [org])).length).toBe(0);
    const grants = await a.unsafe(
      "select has_table_privilege('authenticated','public.golden_build_jobs','select,insert,update,delete') as allowed",
    );
    expect(grants[0].allowed).toBe(false);
  } finally {
    resume();
    await running;
    await a.unsafe("delete from golden_build_jobs where org_id=$1", [org]);
    await a.unsafe("delete from golden_backend_slots where org_id=$1", [org]);
    // Keep the org/admin fixture until the disposable database is destroyed (last-admin guard).
    await Promise.all([a.close(), b.close()]);
  }
});

test.skipIf(!url)(
  "Bun/PostgreSQL golden config bindings persist objects and reject scalar/secret configs",
  async () => {
    const client = new SQL(url!, { max: 1 });
    const adapt = (driver: Pick<SQL, "unsafe">): Sql => ({
      query: async <T>(text: string, params: unknown[] = []) => ({
        rows: Array.from(await driver.unsafe(text, params as never[])) as T[],
      }),
    });
    const sql = adapt(client);
    const store = createSqlGoldenStore(sql);
    const owner = crypto.randomUUID(),
      org = crypto.randomUUID();
    const initial: GoldenConfig = {
      repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }],
      init: [],
    };
    const updated: GoldenConfig = { ...initial, init: ['echo "safe fixture"'] };
    const input = {
      orgId: org,
      ownerId: owner,
      name: "json-binding",
      visibility: "org" as const,
      provider: "boat" as const,
      modal: null,
      config: initial,
    };
    try {
      await sql.query("insert into auth.users(id) values($1)", [owner]);
      await sql.query("insert into orgs(id,name) values($1,$2)", [org, "json-binding-" + org]);
      await sql.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, owner]);
      const golden = await store.insert(input);
      expect(golden.config).toEqual(initial);
      await client.begin(async (tx) => {
        await createSqlGoldenStore(adapt(tx)).setConfig(golden.id, updated);
      });
      expect((await store.findByName(org, input.name))[0]?.config).toEqual(updated);
      expect(
        (await sql.query("select jsonb_typeof(config) as kind from goldens where id=$1", [golden.id])).rows,
      ).toEqual([{ kind: "object" }]);
      // The database guard is still active, including for raw writes that bypass TS types.
      await expect(
        sql.query("update goldens set config=$2::text::jsonb where id=$1", [golden.id, JSON.stringify("scalar")]),
      ).rejects.toMatchObject({ errno: "23514" });
      for (const invalid of ["scalar", { repos: [], init: [], token: "safe-short-fixture" }]) {
        const config = invalid as unknown as GoldenConfig;
        for (const write of [
          () => store.setConfig(golden.id, config),
          () => store.insert({ ...input, name: "invalid-config", config }),
        ]) {
          await expect(write()).rejects.toMatchObject({ name: "GoldenError", code: "invalid_config" });
        }
      }
      expect((await store.findByName(org, input.name))[0]?.config).toEqual(updated);
      expect((await sql.query("select 1 from goldens where org_id=$1", [org])).rows).toHaveLength(1);
    } finally {
      await sql.query("delete from goldens where org_id=$1", [org]);
      // Last-admin guard retains the disposable org/admin until database teardown.
      await client.close();
    }
  },
);
