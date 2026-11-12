import { describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";
import {
  cleanupSandboxes,
  createSqlGoldenStore,
  createSqlSandboxStore,
  type ForkRequest,
  type GoldenActor,
  launchSandbox,
  type Provider,
  type SandboxInfo,
} from "../src/index.ts";
import { serviceGoldenOperations } from "./support/service-golden-operations.ts";

const TOKEN = "sk-ant-oat01-database-test-token";

describe("launch database", () => {
  test("sandbox interior is current owner/admin independently of source and legacy visibility", async () => {
    const db = await openMigratedDatabase();
    try {
      const people = await fixture(db);
      const goldens = { ...createSqlGoldenStore(db), ...serviceGoldenOperations(db) };
      const sandboxes = createSqlSandboxStore(db);
      const boat = fakeBoat();
      const credentials = {
        resolve: async () => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, secrets: [TOKEN], codexAuthJson: false }),
      };
      // Keep golden visibility and subsequent sandbox reads under the user role,
      // but model physical registration and accepted turn receipts through the server connection.
      const stores = {
        goldens,
        credentials,
        sandboxes: {
          ...sandboxes,
          async update(id: string, patch: Parameters<typeof sandboxes.update>[1]) {
            // The API-only client cannot write trusted provider receipts. The
            // launch service records them; raw user-role updates below still
            // exercise the sandbox's actual grants and RLS independently.
            await db.exec("savepoint server_receipt");
            try {
              await db.exec("set local role service_role");
              await sandboxes.update(id, patch);
              await db.exec("release savepoint server_receipt");
            } catch (error) {
              await db.exec("rollback to savepoint server_receipt; release savepoint server_receipt");
              throw error;
            } finally {
              await db.exec("set local role authenticated");
            }
          },
          async insert(input: Parameters<typeof sandboxes.insert>[0]) {
            await db.exec("savepoint server_registration");
            try {
              await db.exec("set local role service_role");
              const row = await sandboxes.insert(input);
              await db.exec("release savepoint server_registration");
              return row;
            } catch (error) {
              await db.exec("rollback to savepoint server_registration; release savepoint server_registration");
              throw error;
            } finally {
              await db.exec("set local role authenticated");
            }
          },
        },
      };

      const mine = await asUser(db, people.owner, () =>
        launchSandbox(boat.provider, stores, actor(people, "owner"), {
          golden: "mine",
          harness: "claude",
          prompt: "go",
        }),
      );
      expect(mine.sandbox).toMatchObject({ ownerId: people.owner, harness: "claude", status: "running" });
      await expect(
        asUser(db, people.owner, () => sandboxes.update(mine.sandbox.id, { taskPromptId: "forged-receipt" })),
      ).rejects.toThrow(/permission denied/);
      expect(boat.forks[0]).toMatchObject({ noEnv: true, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });

      await expect(
        asUser(db, people.member, () =>
          launchSandbox(boat.provider, stores, actor(people, "member"), { golden: "mine", harness: "claude" }),
        ),
      ).rejects.toThrow(/No golden named 'mine'/);
      expect(boat.forks).toHaveLength(1);

      const shared = await asUser(db, people.member, () =>
        launchSandbox(boat.provider, stores, actor(people, "member"), { golden: "shared", harness: "claude" }),
      );
      expect(shared.sandbox).toMatchObject({ ownerId: people.member, status: "ready", conversationIds: [] });

      const privateFork = await asUser(db, people.member, () =>
        launchSandbox(boat.provider, stores, actor(people, "member"), {
          golden: "shared",
          harness: "claude",
          visibility: "private",
        }),
      );
      const sandboxId = privateFork.sandbox.id;
      const serviceData = (await import("../../mcp-server/src/data.ts")).createSqlData(db);
      for (const who of ["owner", "admin"] as const) {
        expect(
          await asUser(db, people[who], async () =>
            (await sandboxes.listBefore("2100-01-01T00:00:00Z")).some((s) => s.id === sandboxId),
          ),
        ).toBe(who === "admin");
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
      expect(
        await asUser(db, people.member, async () =>
          (await sandboxes.listBefore("2100-01-01T00:00:00Z")).some((s) => s.id === sandboxId),
        ),
      ).toBe(true);

      const visible = (userId: string) =>
        asUser(db, userId, async () => (await sandboxes.listBefore("2100-01-01T00:00:00Z")).map((row) => row.id));
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

      await asUser(db, people.owner, () =>
        sandboxes.update(mine.sandbox.id, { status: "failed", statusReason: "Weekly limit reached" }),
      );
      const failed = await asUser(db, people.owner, () => sandboxes.listBefore("2100-01-01T00:00:00Z"));
      expect(failed.find((row) => row.id === mine.sandbox.id)).toMatchObject({
        status: "failed",
        statusReason: "Weekly limit reached",
      });
      await expect(
        db.query("update sandboxes set status = 'running', stopped_at = null where id = $1", [mine.sandbox.id]),
      ).rejects.toThrow(/sandboxes_status_reason_chk/);

      await asUser(db, people.owner, () =>
        sandboxes.update(mine.sandbox.id, { status: "stopped", stoppedAt: "2026-11-08T13:00:00.000Z" }),
      );
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

      const cleaned = await cleanupSandboxes(boat.provider, sandboxes, {
        retentionDays: 7,
        now: new Date(Date.now() + 8 * 86_400_000),
      });
      expect(cleaned.deleted.sort()).toEqual([mine.sandbox.id, shared.sandbox.id, sandboxId].sort());
      const remaining = await db.query<{ status: string }>("select status::text as status from sandboxes");
      expect(remaining.rows.map((row) => row.status)).toEqual(["deleted", "deleted", "deleted"]);
    } finally {
      await db.close();
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
  let count = 0;
  const info = (id: string): SandboxInfo => ({ id, name: id, state: "ready", providerState: "ready", labels: {} });
  const provider = {
    id: "boat",
    harnesses: ["claude", "codex"],
    capabilities: { claude: { reasoningEffort: true }, codex: { reasoningEffort: true } },
    async fork(request: ForkRequest) {
      forks.push(request);
      count += 1;
      return info(`bx_${count}`);
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
    org: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    member: crypto.randomUUID(),
    admin: crypto.randomUUID(),
  };
  for (const user of [people.owner, people.member, people.admin]) {
    await db.query("insert into auth.users (id) values ($1)", [user]);
  }
  await db.query("insert into orgs (id, name) values ($1, 'Example')", [people.org]);
  await db.query(
    `insert into members (org_id, user_id, role) values
      ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'admin')`,
    [people.org, people.owner, people.member, people.admin],
  );
  const config = JSON.stringify({
    repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
    init: [],
  });
  await db.query(
    `insert into goldens (org_id, name, visibility, owner_id, boat_snapshot_id, config) values
      ($1, 'mine', 'private', $2, $4, $6::jsonb),
      ($1, 'shared', 'org', $3, $5, $6::jsonb)`,
    [people.org, people.owner, people.admin, `a${"1".repeat(62)}`, `a${"2".repeat(62)}`, config],
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
