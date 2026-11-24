import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";
import { createSqlData } from "../../mcp-server/src/data.ts";
import { closeableFixture } from "../../mcp-server/test/closeable.fixture.ts";
import { enrolledLaunchPolicy } from "../../mcp-server/test/launch-runtime.fixture.ts";
import {
  createSqlGoldenStore,
  createSqlSandboxStore,
  type ForkRequest,
  type GoldenActor,
  launchSandbox,
  type Provider,
  ProviderError,
  type SandboxInfo,
  type Sql,
} from "../src/index.ts";

const TOKEN = "claude_database_token";

const launchDatabase = closeableFixture(openMigratedDatabase);
beforeAll(launchDatabase.setup);
afterAll(launchDatabase.close);

describe("launch database", () => {
  test.each(["interrupted", "refused", "registered", "commit-unknown", "delete-pending", "deleted"] as const)(
    "ordinary snapshot admission remains protected across a %s fork",
    async (outcome) => {
      const db = launchDatabase.get();
      const people = await fixture(db);
      const commitLost = new Error("admission commit acknowledgement lost");
      const sql: Sql =
        outcome === "commit-unknown"
          ? {
              query: (query, params) => db.query(query, params),
              async transaction(work) {
                await db.transaction(work);
                throw commitLost;
              },
            }
          : db;
      const stores = createSqlData(sql)({
        userId: people.owner,
        orgs: [{ orgId: people.org, role: "member" }],
        via: "supabase",
      });
      const [golden] = await stores.goldens.findByName(people.org, "mine");
      const id = crypto.randomUUID();
      const { provider } = fakeBoat();
      const fork = provider.fork.bind(provider);
      const registrationFailure = new Error("child registration failed");
      const registrationFails = outcome === "delete-pending" || outcome === "deleted";
      let deleteAttempted = false;
      if (registrationFails) {
        provider.delete = async () => {
          deleteAttempted = true;
          return { status: outcome === "delete-pending" ? "pending" : "deleted" };
        };
      }
      const fences = () => db.query("select id from golden_operation_fences where golden_id=$1", [golden!.id]);
      const intents = () =>
        db.query(
          "select golden_id, provider::text, snapshot_id from ordinary_launch_snapshot_intents where sandbox_id=$1",
          [id],
        );
      const expected = [{ golden_id: golden!.id, provider: "boat", snapshot_id: golden!.providerSnapshotId }];
      let atDispatch: { fences: unknown[]; intents: unknown[] } | undefined;
      provider.fork = async (request) => {
        atDispatch = { fences: (await fences()).rows, intents: (await intents()).rows };
        if (outcome === "interrupted") throw new Error("dispatch acknowledgement lost");
        if (outcome === "refused")
          throw new ProviderError({ provider: "boat", code: "invalid_request", message: "refused", retryable: false });
        return fork(request);
      };
      const launch = launchSandbox(
        provider,
        {
          ...stores,
          ...(registrationFails
            ? {
                sandboxes: {
                  ...stores.sandboxes,
                  async insert() {
                    throw registrationFailure;
                  },
                },
              }
            : {}),
          credentials: {
            resolve: async () => ({
              env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
              secrets: [TOKEN],
              codexAuthJson: false,
              binding: { credentialId: people.claudeCredential, credentialVersion: 1 },
            }),
          },
        },
        actor(people, "owner"),
        { golden: "mine", harness: "claude" },
        { newId: () => id, runtime: enrolledLaunchPolicy(db) },
      );
      if (outcome === "registered") {
        expect((await launch).sandbox.id).toBe(id);
        expect(
          (await db.query("select snapshot_id from sandbox_source_snapshots where sandbox_id=$1", [id])).rows,
        ).toEqual([{ snapshot_id: golden!.providerSnapshotId }]);
      } else if (registrationFails) {
        await expect(launch).rejects.toBe(registrationFailure);
        expect(deleteAttempted).toBe(true);
      } else if (outcome === "commit-unknown") {
        await expect(launch).rejects.toBe(commitLost);
      } else {
        await expect(launch).rejects.toMatchObject({
          code: outcome === "interrupted" ? "outcome_unknown" : "invalid_request",
        });
      }
      expect(atDispatch).toEqual(outcome === "commit-unknown" ? undefined : { fences: [], intents: expected });
      expect((await intents()).rows).toEqual(
        ["interrupted", "commit-unknown", "delete-pending"].includes(outcome) ? expected : [],
      );
      expect((await fences()).rows).toEqual([]);
    },
  );

  test.each(["ready", "running", "failed", "stale", "receipt rollback"] as const)(
    "core SQL launch settles %s with its registered generation",
    async (outcome) => {
      const db = launchDatabase.get();
      const people = await fixture(db);
      const { provider } = fakeBoat();
      const sandboxes = createSqlData(db)({
        userId: people.owner,
        via: "service",
        orgs: [{ orgId: people.org, role: "member" }],
      }).sandboxes;
      const id = crypto.randomUUID();
      const stopped: string[] = [];
      provider.stop = async ({ sandboxId }) => {
        stopped.push(sandboxId);
      };
      if (outcome === "failed") {
        provider.get = async () => {
          throw new Error("Initialization failed");
        };
      }
      if (outcome === "receipt rollback") {
        await db.exec(`
          create function pg_temp.reject_core_launch_receipt() returns trigger language plpgsql as $$
          begin
            if new.task_prompt_id is not null and exists (
              select 1 from public.sandbox_transitions where sandbox_id=new.id and to_status='running'
            ) then
              raise exception 'injected receipt failure';
            end if;
            return new;
          end;
          $$;
          create trigger reject_core_launch_receipt before update of task_prompt_id on sandboxes
          for each row when (new.id = '${id}') execute function pg_temp.reject_core_launch_receipt();
        `);
      }
      const prompted = outcome === "running" || outcome === "receipt rollback";
      try {
        const launch = launchSandbox(
          provider,
          {
            goldens: createSqlGoldenStore(db),
            sandboxes,
            credentials: {
              resolve: async () => ({
                env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
                secrets: [TOKEN],
                codexAuthJson: false,
                binding: { credentialId: people.claudeCredential, credentialVersion: 1 },
              }),
            },
          },
          actor(people, "owner"),
          { golden: "mine", harness: "claude", ...(prompted ? { prompt: "go" } : {}) },
          {
            newId: () => id,
            runtime: enrolledLaunchPolicy(db),
            async onRegistered() {
              if (outcome === "stale") await db.query("update sandboxes set lifecycle_generation=2 where id=$1", [id]);
            },
          },
        );
        if (outcome === "ready" || outcome === "running") {
          expect((await launch).sandbox.status).toBe(outcome);
        } else {
          const message =
            outcome === "stale"
              ? "Runtime readiness publication is stale"
              : outcome === "receipt rollback"
                ? "injected receipt failure"
                : "Initialization failed";
          await expect(launch).rejects.toThrow(message);
        }
        expect(stopped).toHaveLength(outcome === "failed" || outcome === "receipt rollback" ? 1 : 0);
        const expectedStatus = outcome === "stale" ? "starting" : outcome === "receipt rollback" ? "failed" : outcome;
        expect(
          (await db.query("select status,task_prompt_id,conversation_ids from sandboxes where id=$1", [id])).rows,
        ).toEqual([
          {
            status: expectedStatus,
            task_prompt_id: outcome === "running" ? "prompt_1" : null,
            conversation_ids: outcome === "running" ? ["conv_1"] : [],
          },
        ]);
        expect(
          (
            await db.query(
              "select from_status,to_status,actor,code,generation::int from sandbox_transitions where sandbox_id=$1 order by id",
              [id],
            )
          ).rows,
        ).toEqual(
          outcome === "stale"
            ? []
            : [
                {
                  from_status: "starting",
                  to_status: expectedStatus,
                  actor: expectedStatus === "failed" ? "lifecycle_runner" : "runtime_enrolment",
                  code: expectedStatus === "failed" ? "launch_failed" : "runtime_enrolled",
                  generation: expectedStatus === "failed" ? 2 : 1,
                },
              ],
        );
      } finally {
        if (outcome === "receipt rollback")
          await db.exec(
            "drop trigger reject_core_launch_receipt on sandboxes; drop function pg_temp.reject_core_launch_receipt()",
          );
      }
    },
  );

  test("sandbox interior is current owner/admin independently of source and legacy visibility", async () => {
    const db = launchDatabase.get();
    try {
      const people = await fixture(db);
      const sandboxes = createSqlSandboxStore(db);
      const boat = fakeBoat();
      const credentials = {
        resolve: async () => ({
          env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
          secrets: [TOKEN],
          codexAuthJson: false,
          binding: { credentialId: people.claudeCredential, credentialVersion: 1 },
        }),
      };
      const serviceData = createSqlData(db);
      const launch = (who: "owner" | "member", request: Parameters<typeof launchSandbox>[3]) => {
        const selected = actor(people, who);
        const stores = serviceData({ userId: selected.userId, orgs: [selected], via: "service" });
        return launchSandbox(boat.provider, { ...stores, credentials }, selected, request, {
          runtime: enrolledLaunchPolicy(db),
        });
      };
      const mine = await launch("owner", { golden: "mine", harness: "claude", prompt: "go" });
      expect(mine.sandbox).toMatchObject({ ownerId: people.owner, harness: "claude", status: "running" });
      await expect(
        asUser(db, people.owner, () => sandboxes.update(mine.sandbox.id, { taskPromptId: "forged-receipt" })),
      ).rejects.toThrow(/permission denied/);
      expect(boat.forks[0]).toMatchObject({ noEnv: true, env: {} });

      await expect(launch("member", { golden: "mine", harness: "claude" })).rejects.toThrow(/No golden named 'mine'/);
      expect(boat.forks).toHaveLength(1);

      const shared = await launch("member", { golden: "shared", harness: "claude" });
      expect(shared.sandbox).toMatchObject({ ownerId: people.member, status: "ready", conversationIds: [] });

      const privateFork = await launch("member", { golden: "shared", harness: "claude", visibility: "private" });
      const sandboxId = privateFork.sandbox.id;
      const visible = (userId: string) =>
        asUser(db, userId, async () =>
          (await db.query<{ id: string }>("select id from sandboxes")).rows.map((row) => row.id),
        );
      for (const who of ["owner", "admin"] as const) {
        expect((await visible(people[who])).includes(sandboxId)).toBe(who === "admin");
        const found = await serviceData({
          userId: people[who],
          orgs: [{ orgId: people.org, role: who === "admin" ? "admin" : "member" }],
          via: "supabase",
        }).sandboxes.get(sandboxId);
        expect(!!found).toBe(who === "admin");
      }
      expect(
        await serviceData({ userId: people.member, orgs: [], via: "supabase" }).sandboxes.get(sandboxId),
      ).toBeNull();
      expect(
        await serviceData({
          userId: people.member,
          orgs: [{ orgId: "ffffffff-ffff-4fff-8fff-ffffffffffff", role: "admin" }],
          via: "supabase",
        }).sandboxes.get(sandboxId),
      ).toBeNull();
      expect((await visible(people.member)).includes(sandboxId)).toBe(true);

      expect(await visible(people.owner)).toEqual(expect.arrayContaining([mine.sandbox.id]));
      expect(await visible(people.member)).toEqual(expect.arrayContaining([shared.sandbox.id, sandboxId]));
      expect(await visible(people.admin)).toEqual(
        expect.arrayContaining([mine.sandbox.id, shared.sandbox.id, sandboxId]),
      );

      await db.query("delete from members where user_id=$1 and org_id=$2", [people.member, people.org]);
      expect(await visible(people.member)).toEqual([]);
      const currentMemberships = (
        await db.query<{ org_id: string; role: "admin" | "member" }>(
          "select org_id,role from members where user_id=$1",
          [people.member],
        )
      ).rows;
      expect(
        await serviceData({
          userId: people.member,
          orgs: currentMemberships.map((m) => ({ orgId: m.org_id, role: m.role })),
          via: "supabase",
        }).sandboxes.get(sandboxId),
      ).toBeNull();
      await db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [people.org, people.member]);

      const privateGolden = await db.query<{ id: string }>("select id from goldens where name = 'mine'");
      await expect(
        asUser(db, people.member, () =>
          sandboxes.insert({
            id: crypto.randomUUID(),
            provider: "boat",
            providerSandboxId: "bx_forged",
            goldenId: privateGolden.rows[0]?.id ?? "",
            orgId: people.org,
            ownerId: people.member,
            harness: "claude",
            status: "starting",
            model: "claude-opus-5-5",
            reasoningEffort: "medium",
          }),
        ),
      ).rejects.toThrow();

      await db.query("update sandboxes set status='failed', status_reason=$2 where id=$1", [
        mine.sandbox.id,
        "Weekly limit reached",
      ]);
      const failed = await serviceData({
        userId: people.owner,
        orgs: [{ orgId: people.org, role: "member" }],
        via: "supabase",
      }).sandboxes.get(mine.sandbox.id);
      expect(failed).toMatchObject({ status: "failed", statusReason: "Weekly limit reached" });
      await expect(
        db.query("update sandboxes set status = 'running', stopped_at = null where id = $1", [mine.sandbox.id]),
      ).rejects.toThrow(/sandboxes_status_reason_chk/);

      await db.query("update sandboxes set status='stopped', status_reason=null, stopped_at=$2 where id=$1", [
        mine.sandbox.id,
        "2026-11-08T13:00:00.000Z",
      ]);
      const stopped = await db.query<{ status: string; stopped_at: Date; status_reason: string | null }>(
        "select status::text as status, stopped_at, status_reason from sandboxes where id = $1",
        [mine.sandbox.id],
      );
      expect(stopped.rows[0]?.status_reason).toBeNull();
      expect(stopped.rows[0]?.status).toBe("stopped");
      expect(stopped.rows[0]?.stopped_at.toISOString()).toBe("2026-11-08T13:00:00.000Z");

      // SQL CHECK must reject a half-recorded choice rather than accept SQL UNKNOWN.
      for (const [model, effort] of [
        ["claude-opus-5-5", null],
        [null, "medium"],
      ]) {
        await expect(
          db.query("update sandboxes set model = $2, reasoning_effort = $3 where id = $1", [
            mine.sandbox.id,
            model,
            effort,
          ]),
        ).rejects.toThrow(/sandboxes_model_chk/);
      }

      await expect(sandboxes.recordSkills!(crypto.randomUUID(), [])).rejects.toThrow(
        "Skill receipts could not be recorded.",
      );
    } finally {
      await db.exec("reset role; reset all; set search_path=public");
    }
  });
});

function actor(
  people: { org: string; owner: string; member: string; admin: string },
  who: "owner" | "member",
): GoldenActor {
  return { userId: people[who], orgId: people.org, role: "member" };
}

function fakeBoat() {
  const forks: ForkRequest[] = [];
  const suffix = crypto.randomUUID();
  let count = 0;
  const info = (id: string): SandboxInfo => ({ id, name: id, state: "ready", providerState: "ready", labels: {} });
  const provider = {
    id: "boat",
    harnesses: ["claude", "codex"],
    capabilities: { claude: { reasoningEffort: true }, codex: { reasoningEffort: true } },
    async fork(request: ForkRequest) {
      forks.push(request);
      count += 1;
      return info(`bx_${suffix}_${count}`);
    },
    async get(sandboxId: string) {
      return info(sandboxId);
    },
    async exec() {
      return { detached: false as const, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
    },
    async prompt() {
      return { promptId: "prompt_1", conversationId: "conv_1", status: "queued" as const };
    },
    async delete() {
      return { status: "pending" };
    },
  } as unknown as Provider;
  return { provider, forks };
}

async function fixture(db: PGlite) {
  const people = {
    claudeCredential: crypto.randomUUID(),
    org: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    member: crypto.randomUUID(),
    admin: crypto.randomUUID(),
  };
  for (const user of [people.owner, people.member, people.admin]) {
    await db.query("insert into auth.users (id) values ($1)", [user]);
  }
  await db.query("insert into orgs (id, name) values ($1, $2)", [people.org, people.org]);
  await db.query(
    `insert into members (org_id, user_id, role) values
      ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'admin')`,
    [people.org, people.owner, people.member, people.admin],
  );
  await db.query(
    "insert into credentials (id,scope,owner_id,kind,value_enc) values ($1,'org',$2,'claude_oauth','fixture')",
    [people.claudeCredential, people.org],
  );
  const config = JSON.stringify({
    repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
    init: [],
  });
  await db.query(
    `insert into goldens (org_id, name, visibility, owner_id, boat_snapshot_id, config) values
      ($1, 'mine', 'private', $2, $4, $6::jsonb),
      ($1, 'shared', 'org', $3, $5, $6::jsonb)`,
    [
      people.org,
      people.owner,
      people.admin,
      `a${people.owner.replaceAll("-", "").padEnd(62, "1")}`,
      `a${people.admin.replaceAll("-", "").padEnd(62, "2")}`,
      config,
    ],
  );
  return people;
}

async function asUser<T>(db: PGlite, userId: string, run: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await db.exec("set local role authenticated");
    const value = await run();
    await db.exec("commit");
    return value;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
