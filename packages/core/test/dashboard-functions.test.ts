import { describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";

type People = { org: string; admin: string; owner: string; member: string; outsider: string };

describe("dashboard functions", () => {
  test("a signed-in user creates an org and becomes its admin", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const org = await asUser(db, people.outsider, async () => {
        const result = await db.query<{ id: string }>("select public.create_org('  New Org  ') as id");
        return result.rows[0]?.id ?? "";
      });
      const stored = await db.query<{ name: string; role: string; user_id: string }>(
        "select o.name, m.role, m.user_id from orgs o join members m on m.org_id = o.id where o.id = $1",
        [org],
      );
      expect(stored.rows).toEqual([{ name: "New Org", role: "admin", user_id: people.outsider }]);

      await expect(db.query("select public.create_org('Nobody')")).rejects.toThrow(/sign in to create an org/);
      await expect(asUser(db, people.outsider, () => db.query("select public.create_org('   ')"))).rejects.toThrow(
        /orgs_name_chk/,
      );
    });
  });

  test("members see the roster with emails, outsiders see nothing", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const roster = await asUser(db, people.member, () =>
        db.query<{ email: string; role: string }>("select email, role from public.org_members($1)", [people.org]),
      );
      expect(roster.rows.map((row) => `${row.email}:${row.role}`).sort()).toEqual([
        "admin@example.com:admin",
        "member@example.com:member",
        "owner@example.com:member",
      ]);
      const hidden = await asUser(db, people.outsider, () =>
        db.query("select email from public.org_members($1)", [people.org]),
      );
      expect(hidden.rows).toEqual([]);
    });
  });

  test("only an admin adds an existing account to an org", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      await expect(
        asUser(db, people.member, () =>
          db.query("select public.add_org_member($1, 'outsider@example.com', 'member')", [people.org]),
        ),
      ).rejects.toThrow(/only an org admin adds members/);

      await asUser(db, people.admin, () =>
        db.query("select public.add_org_member($1, ' Outsider@Example.com ', 'member')", [people.org]),
      );
      const added = await db.query("select 1 from members where org_id = $1 and user_id = $2", [
        people.org,
        people.outsider,
      ]);
      expect(added.rows).toHaveLength(1);

      await expect(
        asUser(db, people.admin, () =>
          db.query("select public.add_org_member($1, 'outsider@example.com', 'member')", [people.org]),
        ),
      ).rejects.toThrow(/members_pkey/);
      await expect(
        asUser(db, people.admin, () =>
          db.query("select public.add_org_member($1, 'ghost@example.com', 'member')", [people.org]),
        ),
      ).rejects.toThrow(/signs in to Armada once first/);
    });
  });

  test("only the owner changes the visibility of a golden", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const golden = await insertGolden(db, people, { name: "mine", visibility: "private", owner: people.admin });

      await expect(setVisibility(db, people.member, golden, "org")).rejects.toThrow(/golden not found/);
      await expect(setVisibility(db, people.owner, golden, "org")).rejects.toThrow(/golden not found/);
      // A plain update is still refused, for the owner too.
      await expect(
        asUser(db, people.admin, () => db.query("update goldens set visibility = 'org' where id = $1", [golden])),
      ).rejects.toThrow(/permission denied/);

      await setVisibility(db, people.admin, golden, "org");
      expect(await visibility(db, golden)).toBe("org");
      expect(await sees(db, people.member, golden)).toBe(true);

      await setVisibility(db, people.admin, golden, "private");
      expect(await visibility(db, golden)).toBe("private");
      expect(await sees(db, people.member, golden)).toBe(false);
    });
  });

  test("a member cannot share a golden with the org", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const golden = await insertGolden(db, people, { name: "draft", visibility: "private", owner: people.owner });
      await expect(setVisibility(db, people.owner, golden, "org")).rejects.toThrow(
        /only an org admin shares a golden with the org/,
      );
      expect(await visibility(db, golden)).toBe("private");
    });
  });

  test("the visibility guard still allows the golden sandbox id, and oauth stays service-only", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const golden = await insertGolden(db, people, { name: "build", visibility: "private", owner: people.admin });
      await asUser(db, people.admin, () =>
        db.query("update goldens set boat_sandbox_id = 'sb_1' where id = $1", [golden]),
      );
      const stored = await db.query<{ boat_sandbox_id: string }>("select boat_sandbox_id from goldens where id = $1", [
        golden,
      ]);
      expect(stored.rows[0]?.boat_sandbox_id).toBe("sb_1");

      await expect(asUser(db, people.admin, () => db.query("select id from oauth_clients"))).rejects.toThrow(
        /permission denied/,
      );
      await expect(asUser(db, people.admin, () => db.query("select hash from oauth_codes"))).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  test("a golden stays shared while another member has a sandbox of it", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const golden = await insertGolden(db, people, { name: "shared", visibility: "org", owner: people.admin });
      await db.query(
        `insert into sandboxes (boat_id, golden_id, org_id, owner_id, harness, status)
         values ('bx_1', $1, $2, $3, 'claude', 'ready')`,
        [golden, people.org, people.member],
      );
      await expect(setVisibility(db, people.admin, golden, "private")).rejects.toThrow(
        /other members still have sandboxes/,
      );
      expect(await visibility(db, golden)).toBe("org");
    });
  });
});

async function withDb(run: (db: PGlite) => Promise<void>): Promise<void> {
  const db = await openMigratedDatabase();
  try {
    await run(db);
  } finally {
    await db.close();
  }
}

async function fixture(db: PGlite): Promise<People> {
  const people: People = {
    org: crypto.randomUUID(),
    admin: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    member: crypto.randomUUID(),
    outsider: crypto.randomUUID(),
  };
  const emails: [string, string][] = [
    [people.admin, "admin@example.com"],
    [people.owner, "owner@example.com"],
    [people.member, "member@example.com"],
    [people.outsider, "outsider@example.com"],
  ];
  for (const [id, email] of emails) {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  }
  await db.query("insert into orgs (id, name) values ($1, 'Example Org')", [people.org]);
  await db.query(
    `insert into members (org_id, user_id, role) values
      ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')`,
    [people.org, people.admin, people.owner, people.member],
  );
  return people;
}

async function insertGolden(
  db: PGlite,
  people: People,
  input: { name: string; visibility: "org" | "private"; owner: string },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into goldens (org_id, name, visibility, owner_id)
     values ($1, $2, $3::public.visibility, $4) returning id`,
    [people.org, input.name, input.visibility, input.owner],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("golden insert returned no id");
  return id;
}

function setVisibility(db: PGlite, user: string, golden: string, next: "org" | "private") {
  return asUser(db, user, () =>
    db.query("select public.set_golden_visibility($1, $2::public.visibility)", [golden, next]),
  );
}

async function visibility(db: PGlite, golden: string): Promise<string | undefined> {
  const result = await db.query<{ visibility: string }>("select visibility from goldens where id = $1", [golden]);
  return result.rows[0]?.visibility;
}

async function sees(db: PGlite, user: string, golden: string): Promise<boolean> {
  const result = await asUser(db, user, () => db.query("select id from goldens where id = $1", [golden]));
  return result.rows.length === 1;
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
