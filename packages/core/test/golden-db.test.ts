import { describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import {
  configFromFlags,
  createGolden,
  createSqlGoldenStore,
  type GoldenActor,
  goldenForLaunch,
  type Provider,
  type SandboxInfo,
  snapshotGolden,
} from "../src/index.ts";

const WEB = "https://github.com/example/web.git";
const API = "https://github.com/example/api.git";

describe("golden database", () => {
  test("a private golden is invisible to other members, and an org golden is not", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      const store = createSqlGoldenStore(db);
      const boat = readyProvider();

      await asUser(db, people.admin, () =>
        createGolden(boat, store, actor(people, "admin"), {
          name: "shared",
          visibility: "org",
          config: configFromFlags([WEB], ["pnpm i"]),
        }),
      );
      await asUser(db, people.admin, () =>
        snapshotGolden(boat, store, actor(people, "admin"), "shared", { sleep: async () => {}, snapshotPolls: 2 }),
      );
      const launched = await asUser(db, people.member, () => goldenForLaunch(store, actor(people, "member"), "shared"));
      expect(launched.visibility).toBe("org");
      expect(launched.boatSnapshotId).toHaveLength(63);

      await asUser(db, people.owner, () =>
        createGolden(boat, store, actor(people, "owner"), {
          name: "kept",
          visibility: "private",
          config: configFromFlags([WEB, API], ["pnpm i"]),
        }),
      );
      await asUser(db, people.owner, () =>
        snapshotGolden(boat, store, actor(people, "owner"), "kept", { sleep: async () => {}, snapshotPolls: 2 }),
      );
      const owned = await asUser(db, people.owner, () => goldenForLaunch(store, actor(people, "owner"), "kept"));
      expect(owned.name).toBe("kept");

      expect(await asUser(db, people.member, () => store.list(people.org))).toEqual([
        expect.objectContaining({ name: "shared", visibility: "org" }),
      ]);
      expect(await asUser(db, people.admin, () => store.findByName(people.org, "kept"))).toEqual([]);
      await expect(
        asUser(db, people.member, () => goldenForLaunch(store, actor(people, "member"), "kept")),
      ).rejects.toThrow(/No golden named 'kept'/);
      await expect(asUser(db, people.admin, () => store.setSnapshot(owned.id, "bbbbbbbbbb"))).rejects.toThrow(
        /could not be updated|cannot change this golden/,
      );
      expect((await asUser(db, people.owner, () => store.findByName(people.org, "kept")))[0]?.boatSnapshotId).toBe(
        owned.boatSnapshotId,
      );
    } finally {
      await db.close();
    }
  });

  test("a member cannot insert an org golden, and the database still refuses a secret config", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      const store = createSqlGoldenStore(db);
      await asUser(db, people.admin, () =>
        store.insert({
          orgId: people.org,
          name: "shared",
          visibility: "org",
          ownerId: people.admin,
          config: configFromFlags([WEB], []),
        }),
      );
      await expect(
        asUser(db, people.member, () =>
          store.insert({
            orgId: people.org,
            name: "nope",
            visibility: "org",
            ownerId: people.member,
            config: configFromFlags([WEB], []),
          }),
        ),
      ).rejects.toThrow(/cannot change this golden|row-level security/);
      await expect(
        db.query(
          `insert into goldens (org_id, name, visibility, owner_id, config)
           values ($1, 'leaky', 'private', $2, '{"password":"nope"}'::jsonb)`,
          [people.org, people.owner],
        ),
      ).rejects.toThrow(/must not contain secrets/);
    } finally {
      await db.close();
    }
  });
});

function actor(
  people: { org: string; owner: string; member: string; admin: string },
  who: "owner" | "member" | "admin",
): GoldenActor {
  return {
    userId: people[who],
    orgId: people.org,
    role: who === "admin" ? "admin" : "member",
  };
}

function readyProvider(): Provider {
  let next = 0;
  const sandbox = (): SandboxInfo => ({
    id: `bx_${++next}`,
    name: "box",
    state: "ready",
    providerState: "ready",
    labels: {},
  });
  const ok = { detached: false as const, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
  return {
    id: "fake",
    harnesses: ["claude", "codex"],
    capabilities: { claude: caps(), codex: caps() },
    createGolden: async () => sandbox(),
    snapshot: async () => ({ name: "saving", status: "saving" }),
    getSnapshot: async () => ({ name: "ready", status: "ready" }),
    deleteSnapshot: async () => {},
    fork: async () => sandbox(),
    get: async () => sandbox(),
    list: async () => ({ items: [], cursor: null }),
    prompt: async () => ({ promptId: "p", conversationId: "c", status: "queued" }),
    getPrompt: async () => ({ promptId: "p", status: "finished", done: true }),
    steer: async () => ({ conversationId: "c", promptId: "p" }),
    interrupt: async () => {},
    exec: async () => ok,
    events: async () => ({ events: [], hasMore: false }),
    stop: async () => {},
    delete: async () => ({ status: "pending" }),
  };
}

function caps() {
  return {
    steer: "none" as const,
    interrupt: false,
    resume: false,
    parallelConversations: false,
    reasoningEffort: false,
    fast: false,
    streamsPartials: false,
    toolEvents: false,
    approvals: false,
  };
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
