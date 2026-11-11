import { expect, test } from "bun:test";
import {
  createSqlMcpRegistry,
  createSqlSandboxStore,
  OrchestratorAuthority,
  type Provider,
  type Sql,
} from "@armada/core/server";
import { createMcpLifecycle } from "../src/mcp-lifecycle.ts";
import { createOrchestratorChildren } from "../src/orchestrator-children.ts";
import { createSandboxArmadaAccess } from "../src/sandbox-armada-access.ts";
import { database, ENCRYPTION_KEY, fakeBoat, PUBLIC_URL } from "./support.ts";

// Primary contract: an ordinary parent obtains only delegated child authority;
// no managed-orchestrator identity is needed, and checkpointing fails closed.
test("ordinary sandbox opt-in bounds child admission and scrubs authority before stop without hiding the parent", async () => {
  const { db, people } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  try {
    const golden = (
      await db.query<{
        id: string;
      }>(`insert into goldens(org_id,name,visibility,owner_id,provider,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
      select org_id,'modal-access','org',owner_id,'modal','image','workspace','main','app',config from goldens where name='shared' returning id`)
    ).rows[0]!;
    const account = (await db.query<{ id: string }>("select id from credentials where kind='openai'")).rows[0]!;
    const fake = fakeBoat();
    const info = await fake.provider.fork({ from: "test", name: "parent", ttlSeconds: 3600, env: {}, noEnv: true });
    let token = "";
    let scrubFails = false;
    let parentActive = false;
    const effects: string[] = [];
    const provider: Provider = {
      ...fake.provider,
      id: "modal",
      get: async (id) => ({ ...(await fake.provider.get(id)), physicalGeneration: "1" }),
      installOrchestratorEpoch: async (request) => {
        if (parentActive) throw Error("native_busy");
        token = request.token;
        return { acknowledged: true };
      },
      scrubOrchestratorEpoch: async () => {
        effects.push("scrub");
        if (scrubFails) throw Error("unavailable");
        return { acknowledged: true };
      },
      quiesceOrchestrator: async () => {
        effects.push("quiesce");
        return { acknowledged: true };
      },
      stop: async (request) => {
        effects.push("stop");
        await fake.provider.stop(request);
      },
    };
    const saved = await createSqlSandboxStore(sql, { turnModels: true }).insert({
      id: crypto.randomUUID(),
      provider: "modal",
      providerSandboxId: info.id,
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "codex",
      status: "starting",
      model: "m",
      reasoningEffort: "high",
      visibility: "private",
      credentialId: account.id,
      credentialVersion: 1,
    });
    const access = createSandboxArmadaAccess({ sql, encryptionKey: ENCRYPTION_KEY, publicUrl: PUBLIC_URL });
    const wrapped = access.wrap(provider);
    await wrapped.exec({ sandboxId: info.id, command: "true" });
    expect(token).toBe("");
    await access.prepare(
      provider,
      saved,
      { userId: people.owner, orgId: people.org, role: "member" },
      { maxActiveChildren: 1 },
    );
    expect((await db.query("select id from orchestrators")).rows).toHaveLength(0);
    expect((await db.query("select id from sandboxes where id=$1", [saved.id])).rows).toHaveLength(1);
    const authority = new OrchestratorAuthority(sql, async () => {});
    let allocations = 0;
    const children = createOrchestratorChildren(sql, authority, {
      launch: async () => {
        allocations++;
        throw Error("response lost");
      },
      message: async () => {},
      stop: async () => {},
      read: async () => null,
      reconcile: async (operation) => ({ operationId: operation.id, sandboxId: operation.sandboxId, state: "unknown" }),
    });
    const selection = {
      goldenId: golden.id,
      harness: "codex" as const,
      credentialId: account.id,
      credentialVersion: 1,
      model: "m",
    };
    const activeToken = token;
    parentActive = true;
    provider.prompt = async (request) => {
      await access.beforePrompt(provider, request.sandboxId);
      throw Error("native_busy");
    };
    await expect(
      wrapped.prompt({ sandboxId: info.id, harness: "codex", text: "conflicting follow-up" }),
    ).rejects.toThrow("native_busy");
    expect(
      await authority.admit(
        activeToken,
        { method: "launch", ...selection },
        async (_tx, principal) => principal.ownerId,
      ),
    ).toBe(people.owner);
    parentActive = false;
    expect((await children.launch(token, "first", selection)).state).toBe("uncertain");
    await expect(children.launch(token, "second", selection)).rejects.toThrow("child policy");
    expect(allocations).toBe(1);
    await expect(children.launch(token, "foreign", { ...selection, goldenId: crypto.randomUUID() })).rejects.toThrow(
      "denied",
    );
    scrubFails = true;
    await expect(wrapped.stop({ sandboxId: info.id })).rejects.toThrow("denied");
    expect(effects).toEqual(["quiesce", "scrub"]);
    await expect(children.launch(token, "after-stop", selection)).rejects.toThrow("denied");
    scrubFails = false;
    await wrapped.stop({ sandboxId: info.id });
    expect(effects.at(-1)).toBe("stop");
    const previousToken = token;
    await db.query(
      "update sandboxes set status='stopped',stopped_at=now(),conversation_ids=array['remembered-conversation'],lifecycle_generation=lifecycle_generation+1 where id=$1",
      [saved.id],
    );
    // The provider activates first; the real MCP lifecycle publishes stopped -> ready
    // before delegated access is installed, just like the native pre-prompt hook.
    fake.sandbox(info.id).info.state = "ready";
    provider.configureMcp = async () => {};
    const mcp = createMcpLifecycle({
      sql,
      registry: createSqlMcpRegistry(sql, ENCRYPTION_KEY),
      encryptionKey: ENCRYPTION_KEY,
      origin: PUBLIC_URL,
    });
    await mcp.beforePrompt(provider, info.id, { userId: people.owner, orgId: people.org });
    await expect(access.beforePrompt(provider, info.id)).resolves.toBeUndefined();
    await db.query("update sandboxes set status='running',lifecycle_generation=lifecycle_generation+1 where id=$1", [
      saved.id,
    ]);
    expect(
      await authority.admit(token, { method: "launch", ...selection }, async (_tx, principal) => principal.ownerId),
    ).toBe(people.owner);
    await expect(authority.admit(previousToken, { method: "launch", ...selection }, async () => true)).rejects.toThrow(
      "denied",
    );
    expect(
      (await db.query<{ conversation_ids: string[] }>("select conversation_ids from sandboxes where id=$1", [saved.id]))
        .rows[0]?.conversation_ids,
    ).toEqual(["remembered-conversation"]);
  } finally {
    await db.close();
  }
});
