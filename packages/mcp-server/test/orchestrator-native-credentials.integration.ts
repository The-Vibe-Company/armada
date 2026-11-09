// Explicit actual603 eab + actual604 77eed87 + merged main, never native support proof.
import { expect, test } from "bun:test";
import * as core from "@armada/core/server";
import { launchOrchestratorParent } from "../src/orchestrator-launch.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { database } from "./support.ts";

test("parent launch preserves native credential admission before allocation and releases unallocated ownership", async () => {
  const { db, people: p } = await database();
  const sql: core.Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  try {
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw Error("missing golden");
    const choice = core.resolveModelChoice("codex", {});
    const credentialId = crypto.randomUUID();
    const configuration = {
      version: 1 as const,
      orgId: p.org,
      name: "native admission",
      provider: "boat" as const,
      harness: "codex" as const,
      goldenId: golden.id,
      model: choice.model,
      reasoningEffort: choice.reasoningEffort,
      modelAccountId: credentialId,
    };
    const store = new OrchestratorRuntimeStore(sql, core.reserveOrchestratorOperation);
    const reservation = await store.create({
      ownerId: p.owner,
      configuration,
      key: "native-admission",
      skillRevision: "a".repeat(40),
    });
    let forks = 0,
      released = 0;
    const credentials = { env: {}, secrets: [], codexAuthJson: false, binding: { credentialId, credentialVersion: 1 } };
    // Prototype hooks ensure no spread/copy of a partial resolver can silently drop ownership.
    const lifecycle = Object.assign(
      Object.create({
        async admit() {
          throw Error("native admission denied");
        },
        async releaseUnallocated() {
          released++;
        },
      }),
      { resolve: async () => credentials },
    ) as core.LaunchStores["credentials"];
    const provider = {
      id: "boat",
      harnesses: ["claude", "codex"],
      capabilities: { claude: { reasoningEffort: true }, codex: { reasoningEffort: true } },
      fork: async () => {
        forks++;
        throw Error("unexpected fork before native admission");
      },
    } as unknown as core.Provider;
    await expect(
      launchOrchestratorParent({
        sql,
        provider,
        stores: {
          goldens: core.createSqlGoldenStore(sql),
          sandboxes: core.createSqlSandboxStore(sql),
          credentials: lifecycle,
        },
        actor: { userId: p.owner, orgId: p.org, role: "member" },
        request: {
          golden: "shared",
          provider: "boat",
          harness: "codex",
          model: choice.model,
          reasoningEffort: choice.reasoningEffort,
        },
        reservation,
        account: { credentialId, credentialVersion: 1, resolve: async () => credentials },
      }),
    ).rejects.toThrow("native admission denied");
    expect(forks).toBe(0);
    expect(released).toBe(1);
  } finally {
    await db.close();
  }
});

test("shared golden parent launch retains source authority but binds a private promptless parent", async () => {
  const { fakeBoat } = await import("./support.ts");
  const { db, people: p } = await database();
  const sql: core.Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const boat = fakeBoat();
  try {
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!;
    const choice = core.resolveModelChoice("claude", {}),
      credentialId = crypto.randomUUID();
    const store = new OrchestratorRuntimeStore(sql, core.reserveOrchestratorOperation);
    const reservation = await store.create({
      ownerId: p.owner,
      configuration: {
        version: 1,
        orgId: p.org,
        name: "private parent",
        provider: "boat",
        harness: "claude",
        goldenId: golden.id,
        model: choice.model,
        reasoningEffort: choice.reasoningEffort,
        modelAccountId: credentialId,
      },
      key: "shared",
      skillRevision: "a".repeat(40),
    });
    const credentials = { env: {}, secrets: [], codexAuthJson: false, binding: { credentialId, credentialVersion: 1 } };
    const scopes: string[] = [];
    await launchOrchestratorParent({
      sql,
      provider: boat.provider,
      actor: { userId: p.owner, orgId: p.org, role: "member" },
      request: { golden: "shared", provider: "boat", harness: "claude", ...choice },
      reservation,
      account: { credentialId, credentialVersion: 1, resolve: async () => credentials },
      stores: {
        goldens: core.createSqlGoldenStore(sql),
        sandboxes: core.createSqlSandboxStore(sql),
        credentials: { resolve: async () => credentials },
        connections: {
          defaults: async (_actor, visibility) => {
            scopes.push(visibility);
            return [];
          },
          validate: async () => {},
          bind: async () => {},
        },
      },
    });
    const identity = await store.read(p.owner, p.org, reservation.identity.id);
    expect(identity.sandboxId).not.toBeNull();
    const saved = (
      await db.query<{
        visibility: string;
        source_golden_visibility: string;
        access_owner_id: string;
        status: string;
        credential_id: string;
      }>("select visibility,source_golden_visibility,access_owner_id,status,credential_id from sandboxes where id=$1", [
        identity.sandboxId,
      ])
    ).rows[0]!;
    expect(saved).toMatchObject({
      visibility: "private",
      source_golden_visibility: "org",
      access_owner_id: p.owner,
      status: "ready",
      credential_id: credentialId,
    });
    expect(scopes).toEqual(["private"]);
    await expect(store.read(p.admin, p.org, reservation.identity.id)).rejects.toThrow("not_found");
  } finally {
    await db.close();
  }
});
