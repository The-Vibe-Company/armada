import { expect, test } from "bun:test";
import { createSqlData } from "../src/data.ts";
import { database } from "./support.ts";

test("scoped golden reads preserve persisted build warnings without exposing private or removed rows", async () => {
  const { db, people } = await database();
  try {
    const warnings = ["skillpack_download_unavailable"];
    await db.query("update goldens set build_warnings=$1::text[] where org_id=$2", [warnings, people.org]);
    await db.query(
      "insert into goldens(org_id,name,visibility,owner_id,config,removed_at) select org_id,'removed',visibility,owner_id,config,now() from goldens where name='shared'",
    );
    const store = createSqlData(db)({
      userId: people.member,
      via: "supabase",
      orgs: [{ orgId: people.org, role: "member" }],
    }).goldens;
    const listed = await store.list(people.org);
    expect(listed.map((golden) => golden.name)).toEqual(["shared"]);
    expect(listed[0]?.buildWarnings).toEqual(warnings);
    const found = await store.findByName(people.org, "shared");
    expect(found).toHaveLength(1);
    expect(found[0]?.buildWarnings).toEqual(warnings);
    expect(await store.findByName(people.org, "mine")).toEqual([]);
    expect(await store.findByName(people.org, "removed")).toEqual([]);

    await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.member]);
    expect(await store.list(people.org)).toEqual([]);
    expect(await store.findByName(people.org, "shared")).toEqual([]);
  } finally {
    await db.close();
  }
});
