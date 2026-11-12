import { expect, test } from "bun:test";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";
import {
  connectGolden,
  createSqlGoldenStore,
  type GoldenActor,
  type GoldenStore,
  type Provider,
  ProviderError,
  type SnapshotInfo,
  snapshotGolden,
} from "../src/server.ts";

test.each([
  "remapped-ready",
  "foreign-source",
  "last-good-alias",
  "lost-request",
  "lost-publication",
  "lost-ack",
  "lost-readback",
  "known-failed",
] as const)("Modal manual save verifies and publishes the actual immutable reference (%s)", async (mode) => {
  const db = await openMigratedDatabase();
  try {
    const actor: GoldenActor = { orgId: crypto.randomUUID(), userId: crypto.randomUUID(), role: "admin" };
    await db.query("insert into auth.users(id) values($1)", [actor.userId]);
    await db.query("insert into orgs(id,name) values($1,'snapshots')", [actor.orgId]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [actor.orgId, actor.userId]);
    const store = createSqlGoldenStore(db);
    const golden = await store.insert({
      orgId: actor.orgId,
      ownerId: actor.userId,
      name: "web",
      visibility: "org",
      provider: "modal",
      modal: { workspace: "ws", appId: "ap-bound", environment: "main" },
      config: { repos: [{ url: "https://github.com/fixture/app.git", branch: "main", dir: "app" }], init: [] },
    });
    await store.setSandbox(golden.id, "master");
    await store.setSnapshot(golden.id, "last-good");
    const artifacts = new Map<string, SnapshotInfo>([
      ["last-good", { name: "last-good", status: "ready", sourceSandboxId: "master" }],
    ]);
    let requested = "";
    let stopped = false;
    let deletions = 0;
    const actual = mode === "last-good-alias" ? "last-good" : "im-provider-remapped";
    let publicationLost = false;
    const provider = {
      restoreGoldenMaster: async () => {
        stopped = false;
        return { id: "master", state: "ready" };
      },
      id: "modal",
      get: async () => ({
        id: "master",
        name: "web",
        state: stopped ? "stopped" : "ready",
        providerState: "",
        labels: {},
      }),
      snapshot: async ({ name }: { name: string }) => {
        requested = name;
        if (mode !== "last-good-alias")
          artifacts.set(actual, {
            name: actual,
            status: mode === "known-failed" ? "failed" : "ready",
            sourceSandboxId: mode === "foreign-source" ? "someone-else" : "master",
          });
        if (mode === "lost-request")
          throw new ProviderError({
            provider: "modal",
            code: "unavailable",
            retryable: true,
            message: "upstream-sensitive",
          });
        return {
          name: actual,
          status: mode === "known-failed" ? "failed" : "saving",
          sourceSandboxId: artifacts.get(actual)?.sourceSandboxId,
        };
      },
      getSnapshot: async (name: string) => artifacts.get(name)!,
      stop: async () => {
        stopped = true;
      },
      deleteSnapshot: async () => {
        deletions++;
      },
      delete: async () => {
        deletions++;
      },
    } as unknown as Provider;
    const publication: GoldenStore = {
      ...store,
      async findByName(...args) {
        if (mode === "lost-readback" && publicationLost) throw new Error("readback transport lost");
        return store.findByName(...args);
      },
      async compareAndSetSnapshot(...args) {
        if (mode === "lost-publication") throw new Error("unconfirmed SQL outcome");
        const changed = await store.compareAndSetSnapshot!(...args);
        publicationLost = true;
        if (mode === "lost-readback") throw new Error("publication transport lost");
        if (mode === "lost-ack") throw new Error("acknowledgement lost");
        return changed;
      },
    };
    let result: Awaited<ReturnType<typeof snapshotGolden>> | undefined;
    let error: unknown;
    try {
      result = await snapshotGolden(provider, publication, actor, "web", { sleep: async () => {} });
    } catch (caught) {
      error = caught;
    }
    expect(requested).toMatch(new RegExp(`^golden-${golden.id}-[a-f0-9-]+$`));
    expect(requested).not.toBe("last-good");
    const [stored] = await store.findByName(actor.orgId, "web");
    if (mode === "lost-readback") {
      expect(error).toMatchObject({ details: { keepSource: true } });
      expect(stored).toMatchObject({ providerSnapshotId: actual, providerSandboxId: null });
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor.userId]);
      await expect(db.query("select remove_golden($1)", [golden.id])).rejects.toThrow("unresolved");
      const otherAdmin = crypto.randomUUID();
      await db.query("insert into auth.users(id) values($1)", [otherAdmin]);
      await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [actor.orgId, otherAdmin]);
      await db.query("update members set role='member' where org_id=$1 and user_id=$2", [actor.orgId, actor.userId]);
      await expect(connectGolden(provider, store, actor, "web")).rejects.toMatchObject({ code: "forbidden" });
      expect(
        (await db.query("select id from golden_operation_fences where golden_id=$1", [golden.id])).rows,
      ).toHaveLength(1);
      await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [actor.orgId, actor.userId]);
      await connectGolden(provider, store, actor, "web");
      expect(
        (await db.query("select id from golden_operation_fences where golden_id=$1", [golden.id])).rows,
      ).toHaveLength(0);
      await expect(db.query("select remove_golden($1)", [golden.id])).resolves.toBeDefined();
    } else if (mode === "remapped-ready" || mode === "lost-ack") {
      expect(error).toBeUndefined();
      expect(result?.snapshotName).toBe("im-provider-remapped");
      expect(stored).toMatchObject({
        id: golden.id,
        providerSnapshotId: "im-provider-remapped",
        providerSandboxId: null,
      });
      expect(stopped).toBe(true);
    } else {
      expect(error).toBeDefined();
      expect(stored).toMatchObject({ providerSnapshotId: "last-good", providerSandboxId: "master" });
      if (mode === "lost-request" || mode === "lost-publication") {
        expect(error).toMatchObject({ details: { keepSource: true, sourceSandboxId: "master" }, retryable: false });
        expect(String(error)).toContain("reconcile");
        expect(String(error)).not.toContain("upstream-sensitive");
      } else expect(error).toMatchObject({ code: "snapshot_failed" });
    }
    if (mode === "known-failed" || mode === "remapped-ready" || mode === "lost-ack") {
      expect(
        (await db.query("select id from golden_operation_fences where golden_id=$1", [golden.id])).rows,
      ).toHaveLength(0);
    }
    if (mode === "lost-publication") {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor.userId]);
      await expect(db.query("select remove_golden($1)", [golden.id])).rejects.toThrow("unresolved");
      // A readback of the last-good row is not proof that an in-flight COMMIT rolled back.
      await store.reconcileOperations!(stored!, actor);
      expect(
        (await db.query("select id from golden_operation_fences where golden_id=$1", [golden.id])).rows,
      ).toHaveLength(1);
    }
    expect(deletions).toBe(0);
    expect(artifacts.get("last-good")?.status).toBe("ready");
    if (mode !== "last-good-alias")
      expect(artifacts.get(actual)?.status).toBe(mode === "known-failed" ? "failed" : "ready");
  } finally {
    await db.close();
  }
});
