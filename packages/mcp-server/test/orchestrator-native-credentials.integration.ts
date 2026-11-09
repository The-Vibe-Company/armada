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
