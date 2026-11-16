import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { migrationsDir, openDatabase } from "../../../scripts/db/apply.ts";

describe("org Boat credential upgrade", () => {
  const reconcile = "20261110110200_org_boat_credential_canonical.sql";
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  let connection: Awaited<ReturnType<typeof openDatabase>> | undefined;
  beforeAll(async () => {
    const db = await openDatabase();
    connection = db;
    await db.exec(await Bun.file(new URL("../../../scripts/db/supabase-prereq.sql", import.meta.url)).text());
    for (const file of files.filter((name) => name < reconcile))
      await db.exec(await Bun.file(`${migrationsDir}/${file}`).text());
  });
  afterAll(async () => {
    const db = connection;
    connection = undefined;
    await db?.close();
  });

  test("an org Boat key lives only in its org's column, and duplicate rows reconcile without losing the active key", async () => {
    const db = connection;
    if (!db) throw new Error("Missing org Boat credential schema fixture");
    const [both, rowOnly, user] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await db.query("insert into auth.users (id) values ($1)", [user]);
    await db.query("insert into orgs (id, name, boat_api_key_enc) values ($1, 'Both', '\\x0a'), ($2, 'Row', null)", [
      both,
      rowOnly,
    ]);
    await db.query(
      `insert into credentials (scope, owner_id, kind, value_enc) values
            ('org', $1, 'boat', '\\x0b'), ('org', $2, 'boat', '\\x0c'), ('org', $2, 'modal', '\\x0d'),
            ('user', $3, 'boat', '\\x0e')`,
      [both, rowOnly, user],
    );

    for (const file of files.filter((name) => name >= reconcile))
      await db.exec(await Bun.file(`${migrationsDir}/${file}`).text());

    const columns = await db.query<{ name: string; hex: string }>(
      "select name, encode(boat_api_key_enc, 'hex') as hex from orgs order by name",
    );
    expect(columns.rows).toEqual([
      { name: "Both", hex: "0a" },
      { name: "Row", hex: "0c" },
    ]);
    const rows = await db.query<{ scope: string; kind: string; hex: string }>(
      "select scope::text, kind::text, encode(value_enc, 'hex') as hex from credentials order by hex",
    );
    expect(rows.rows).toEqual([
      { scope: "org", kind: "modal", hex: "0d" },
      { scope: "user", kind: "boat", hex: "0e" },
    ]);
    await expect(
      db.query("insert into credentials (scope, owner_id, kind, value_enc) values ('org', $1, 'boat', '\\x0f')", [
        rowOnly,
      ]),
    ).rejects.toThrow(/credentials_org_boat_chk/);
  });
});
