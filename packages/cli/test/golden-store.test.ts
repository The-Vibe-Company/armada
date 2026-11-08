import { describe, expect, test } from "bun:test";
import type { GoldenConfig } from "@armada/core";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { goldenStore, type Queryable } from "../src/golden-store.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const CONFIG: GoldenConfig = {
  repos: [{ url: "https://example.com/app.git", branch: "main" }, { url: "https://example.com/web.git" }],
  init: ["pnpm i"],
};

describe("golden store", () => {
  test("records a golden and its snapshot without changing org, visibility or owner", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      await db.query("insert into auth.users (id) values ($1)", [OWNER]);
      await db.query("insert into orgs (id, name) values ($1, 'Example')", [ORG]);
      await db.query("insert into members (org_id, user_id, role) values ($1, $2, 'admin')", [ORG, OWNER]);
      const store = goldenStore(db as unknown as Queryable);
      const inserted = await store.insert({
        id: "55555555-5555-4555-8555-555555555555",
        orgId: ORG,
        name: "web",
        visibility: "org",
        ownerId: OWNER,
        boatSnapshotId: null,
        config: CONFIG,
      });
      expect(inserted.boatSnapshotId).toBeNull();
      expect(inserted.config).toEqual(CONFIG);

      const next: GoldenConfig = { ...CONFIG, init: ["pnpm i", "pnpm test"] };
      await store.updateConfig(inserted.id, next);
      await store.setSnapshot(inserted.id, "a111111111111411181111111111111111-abcdefabcdef");
      const [row] = await store.listOrg(ORG);
      expect(row).toMatchObject({
        id: inserted.id,
        orgId: ORG,
        name: "web",
        visibility: "org",
        ownerId: OWNER,
        boatSnapshotId: "a111111111111411181111111111111111-abcdefabcdef",
        config: next,
      });

      await expect(
        store.insert({
          id: "66666666-6666-4666-8666-666666666666",
          orgId: ORG,
          name: "web",
          visibility: "org",
          ownerId: OWNER,
          boatSnapshotId: null,
          config: CONFIG,
        }),
      ).rejects.toMatchObject({ code: "exists" });
    } finally {
      await db.close();
    }
  });
});
