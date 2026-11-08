import { describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
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

const TOKEN = "sk-ant-oat01-database-test-token";

describe("launch database", () => {
  test("a sandbox of a private golden is the owner's alone, and one of an org golden is the org's", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      const goldens = createSqlGoldenStore(db);
      const sandboxes = createSqlSandboxStore(db);
      const boat = fakeBoat();
      const credentials = { get: async () => TOKEN };
      const stores = { goldens, sandboxes, credentials };

      const mine = await asUser(db, people.owner, () =>
        launchSandbox(boat.provider, stores, actor(people, "owner"), {
          golden: "mine",
          harness: "claude",
          prompt: "go",
        }),
      );
      expect(mine.sandbox).toMatchObject({ ownerId: people.owner, harness: "claude", status: "running" });
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

      const visible = (userId: string) =>
        asUser(db, userId, async () => (await sandboxes.listBefore("2100-01-01T00:00:00Z")).map((row) => row.id));
      expect(await visible(people.owner)).toEqual(expect.arrayContaining([mine.sandbox.id, shared.sandbox.id]));
      expect(await visible(people.member)).toEqual([shared.sandbox.id]);
      expect(await visible(people.admin)).toEqual([shared.sandbox.id]);

      const privateGolden = await db.query<{ id: string }>("select id from goldens where name = 'mine'");
      await expect(
        asUser(db, people.member, () =>
          sandboxes.insert({
            id: crypto.randomUUID(),
            boatId: "bx_forged",
            goldenId: privateGolden.rows[0]?.id ?? "",
            orgId: people.org,
            ownerId: people.member,
            harness: "claude",
            status: "starting",
          }),
        ),
      ).rejects.toThrow();

      await asUser(db, people.owner, () =>
        sandboxes.update(mine.sandbox.id, { status: "stopped", stoppedAt: "2026-11-08T13:00:00.000Z" }),
      );
      const stopped = await db.query<{ status: string; stopped_at: Date }>(
        "select status::text as status, stopped_at from sandboxes where id = $1",
        [mine.sandbox.id],
      );
      expect(stopped.rows[0]?.status).toBe("stopped");
      expect(stopped.rows[0]?.stopped_at.toISOString()).toBe("2026-11-08T13:00:00.000Z");

      const cleaned = await cleanupSandboxes(boat.provider, sandboxes, {
        retentionDays: 7,
        now: new Date(Date.now() + 8 * 86_400_000),
      });
      expect(cleaned.deleted.sort()).toEqual([mine.sandbox.id, shared.sandbox.id].sort());
      const remaining = await db.query<{ status: string }>("select status::text as status from sandboxes");
      expect(remaining.rows.map((row) => row.status)).toEqual(["deleted", "deleted"]);
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
    id: "fake",
    harnesses: ["claude", "codex"],
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
