import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, migrationsDir, openDatabase } from "../../../scripts/db/apply.ts";
import { createSqlGoldenStore, type GoldenActor, goldenForLaunch } from "../src/index.ts";
import { createSqlSandboxStore } from "../src/sandbox.ts";

const IDENTITY = "20261109010000_sandbox_provider_identity.sql";
const CONFIG = JSON.stringify({
  repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
  init: [],
});

describe("sandbox provider identity", () => {
  test("existing goldens and sandboxes are backfilled to Boat with their ids, and server writes keep Boat aliases compatible", async () => {
    const db = await openDatabase();
    try {
      // The database as the previous release left it.
      await applyUpTo(db, IDENTITY);
      const people = await fixture(db);
      const golden = await db.query<{ id: string }>(
        `insert into goldens (org_id, name, visibility, owner_id, boat_sandbox_id, boat_snapshot_id, config)
         values ($1, 'web', 'org', $2, 'bx_builder', 'snap-1', $3::jsonb) returning id`,
        [people.org, people.admin, CONFIG],
      );
      const goldenId = golden.rows[0]?.id;
      await db.query(
        `insert into sandboxes (boat_id, golden_id, org_id, owner_id, harness, status)
         values ('bx_old', $1, $2, $3, 'claude', 'ready')`,
        [goldenId, people.org, people.member],
      );

      await applyFrom(db, IDENTITY);
      expect(
        (await db.query("select provider::text, provider_sandbox_id, provider_snapshot_id, modal_app_id from goldens"))
          .rows,
      ).toEqual([
        { provider: "boat", provider_sandbox_id: "bx_builder", provider_snapshot_id: "snap-1", modal_app_id: null },
      ]);
      expect((await db.query("select provider::text, provider_sandbox_id, boat_id from sandboxes")).rows).toEqual([
        { provider: "boat", provider_sandbox_id: "bx_old", boat_id: "bx_old" },
      ]);

      // A client of the previous release writes boat_* columns; a new one the neutral ones. Both stay one id.
      await asUser(db, people.admin, () =>
        db.query("update goldens set boat_snapshot_id = 'snap-2' where id = $1", [goldenId]),
      );
      // Trusted server writes retain the legacy Boat alias contract.
      await db.query(
        `insert into sandboxes (boat_id, golden_id, org_id, owner_id, harness, status)
         values ('bx_legacy', $1, $2, $3, 'claude', 'starting')`,
        [goldenId, people.org, people.admin],
      );
      expect((await db.query("select provider_snapshot_id, boat_snapshot_id from goldens")).rows).toEqual([
        { provider_snapshot_id: "snap-2", boat_snapshot_id: "snap-2" },
      ]);
      expect(
        (await db.query("select provider::text, provider_sandbox_id from sandboxes where boat_id = 'bx_legacy'")).rows,
      ).toEqual([{ provider: "boat", provider_sandbox_id: "bx_legacy" }]);
    } finally {
      await db.close();
    }
  });

  test("only the service role registers sandbox identities for either provider; existing rows remain readable", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      for (const provider of ["boat", "modal"] as const) {
        const goldenId = await insertGolden(db, people, provider, `snapshot-${provider}`);
        for (const user of [people.member, people.admin]) {
          for (const explicit of [true, false]) {
            await expect(
              asUser(db, user, () =>
                db.query(
                  `insert into sandboxes (provider, provider_sandbox_id, golden_id, org_id, owner_id, harness, status)
                 values ($1::public.sandbox_provider, $2, $3, $4, $5, 'claude', 'ready')`,
                  [explicit ? provider : null, `untrusted-${user}-${explicit}`, goldenId, people.org, user],
                ),
              ),
            ).rejects.toThrow(/permission denied/);
          }
        }
        // Legacy Boat-only identity columns are not a registration escape hatch.
        if (provider === "boat") {
          await expect(
            asUser(db, people.member, () =>
              db.query(
                "insert into sandboxes (boat_id,golden_id,org_id,owner_id,harness,status) values ('legacy-client',$1,$2,$3,'claude','ready')",
                [goldenId, people.org, people.member],
              ),
            ),
          ).rejects.toThrow(/permission denied/);
        }
        await db.exec("set role service_role");
        let registered: Awaited<ReturnType<ReturnType<typeof createSqlSandboxStore>["insert"]>>;
        try {
          registered = await createSqlSandboxStore(db).insert({
            id: crypto.randomUUID(),
            provider,
            providerSandboxId: `trusted-${provider}`,
            goldenId,
            orgId: people.org,
            ownerId: people.member,
            harness: "claude",
            status: "ready",
            model: "claude-sonnet-4-6",
            reasoningEffort: "high",
          });
        } finally {
          await db.exec("reset role");
        }
        expect(registered.providerSandboxId).toBe(`trusted-${provider}`);
        const rows = await asUser(db, people.member, () =>
          db.query("select id from sandboxes where id = $1", [registered.id]),
        );
        expect(rows.rows).toEqual([{ id: registered.id }]);
      }
    } finally {
      await db.close();
    }
  });

  test("a name lives once per provider, identities are fixed, and a user JWT cannot write or relabel a Modal golden", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const people = await fixture(db);
      const boatId = await insertGolden(db, people, "boat", "snap-boat");
      // The server (service role here) writes the Modal golden of the same name, pinned to its App.
      const modalId = await insertGolden(db, people, "modal", "im-modal");
      await expect(insertGolden(db, people, "modal", "im-other")).rejects.toThrow(/goldens_org_name_key/);

      const store = createSqlGoldenStore(db);
      const member: GoldenActor = { userId: people.member, orgId: people.org, role: "member" };
      await expect(asUser(db, people.member, () => goldenForLaunch(store, member, "web"))).rejects.toThrow(
        "exists on boat and modal",
      );
      const modal = await asUser(db, people.member, () => goldenForLaunch(store, member, "web", "modal"));
      expect(modal).toMatchObject({
        id: modalId,
        providerSnapshotId: "im-modal",
        modal: { workspace: "ws-acme", environment: "main", appId: "ap-pinned" },
      });
      expect((await asUser(db, people.member, () => goldenForLaunch(store, member, "web", "boat"))).id).toBe(boatId);

      const refused = async (text: string, params: unknown[]) =>
        asUser(db, people.admin, () => db.query(text, params)).then(
          () => "allowed",
          (error: Error) => error.message,
        );
      // An org admin, through a user JWT.
      expect(await refused("update goldens set provider = 'modal' where id = $1", [boatId])).toContain(
        "permission denied",
      );
      expect(await refused("update goldens set provider_snapshot_id = 'im-evil' where id = $1", [modalId])).toContain(
        "written by the Armada server only",
      );
      expect(await refused("update goldens set boat_snapshot_id = 'snap-evil' where id = $1", [modalId])).not.toBe(
        "allowed",
      );
      expect(
        await refused(
          `insert into goldens (org_id, name, visibility, owner_id, provider, provider_snapshot_id, modal_workspace,
             modal_environment, modal_app_id, config)
           values ($1, 'forged', 'org', $2, 'modal', 'im-forged', 'ws-other', 'main', 'ap-other', '{}'::jsonb)`,
          [people.org, people.admin],
        ),
      ).toContain("written by the Armada server only");
      // Exercise provider consistency as the trusted writer so permission denial cannot mask this contract.
      await expect(
        db.query(
          `insert into sandboxes (provider, provider_sandbox_id, golden_id, org_id, owner_id, harness, status)
         values ('boat', 'bx_cross', $1, $2, $3, 'claude', 'starting')`,
          [modalId, people.org, people.admin],
        ),
      ).rejects.toThrow("golden's provider");

      // Not even the server relabels a golden or moves it to another App: a rotated token cannot redirect it.
      await expect(db.query("update goldens set provider = 'modal' where id = $1", [boatId])).rejects.toThrow(
        "immutable",
      );
      await expect(
        db.query("update goldens set modal_app_id = 'ap-elsewhere' where id = $1", [modalId]),
      ).rejects.toThrow("immutable");
      // Another org sees neither.
      const outsider = crypto.randomUUID();
      await db.query("insert into auth.users (id) values ($1)", [outsider]);
      const seen = await asUser(db, outsider, () => db.query("select id from goldens"));
      expect(seen.rows).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

async function insertGolden(db: PGlite, people: People, provider: "boat" | "modal", snapshot: string): Promise<string> {
  const modal = provider === "modal" ? ["ws-acme", "main", "ap-pinned"] : [null, null, null];
  const result = await db.query<{ id: string }>(
    `insert into goldens (org_id, name, visibility, owner_id, provider, provider_snapshot_id, modal_workspace,
       modal_environment, modal_app_id, config)
     values ($1, 'web', 'org', $2, $3::public.sandbox_provider, $4, $5, $6, $7, $8::jsonb) returning id`,
    [people.org, people.admin, provider, snapshot, ...modal, CONFIG],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("no golden");
  return id;
}

type People = { org: string; member: string; admin: string };

async function fixture(db: PGlite): Promise<People> {
  const people = { org: crypto.randomUUID(), member: crypto.randomUUID(), admin: crypto.randomUUID() };
  for (const user of [people.member, people.admin]) await db.query("insert into auth.users (id) values ($1)", [user]);
  await db.query("insert into orgs (id, name) values ($1, 'Example')", [people.org]);
  await db.query("insert into members (org_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'admin')", [
    people.org,
    people.member,
    people.admin,
  ]);
  return people;
}

const PREREQ = fileURLToPath(new URL("../../../scripts/db/supabase-prereq.sql", import.meta.url));

function migrations(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

async function applyUpTo(db: PGlite, first: string): Promise<void> {
  await db.exec(await Bun.file(PREREQ).text());
  for (const file of migrations().filter((name) => name < first)) {
    await db.exec(await Bun.file(join(migrationsDir, file)).text());
  }
}

async function applyFrom(db: PGlite, first: string): Promise<void> {
  for (const file of migrations().filter((name) => name >= first)) {
    await db.exec(await Bun.file(join(migrationsDir, file)).text());
  }
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
