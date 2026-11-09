import { expect, test } from "bun:test";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import {
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
] as const)("Modal manual save verifies and publishes the actual immutable reference (%s)", async (mode) => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
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
    const provider = {
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
            status: "ready",
            sourceSandboxId: mode === "foreign-source" ? "someone-else" : "master",
          });
        if (mode === "lost-request")
          throw new ProviderError({
            provider: "modal",
            code: "unavailable",
            retryable: true,
            message: "upstream-sensitive",
          });
        return { name: actual, status: "saving", sourceSandboxId: artifacts.get(actual)?.sourceSandboxId };
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
      async compareAndSetSnapshot(...args) {
        if (mode === "lost-publication") throw new Error("unconfirmed SQL outcome");
        const changed = await store.compareAndSetSnapshot!(...args);
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
    if (mode === "remapped-ready" || mode === "lost-ack") {
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
    expect(deletions).toBe(0);
    expect(artifacts.get("last-good")?.status).toBe("ready");
    if (mode !== "last-good-alias") expect(artifacts.get(actual)?.status).toBe("ready");
  } finally {
    await db.close();
  }
});
