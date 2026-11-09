// Actual603/604 dependency combination; fake placement only, never native conformance.
import { expect, test } from "bun:test";
import * as core from "@armada/core/server";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createOrchestratorBackendResolver } from "../src/orchestrator-backend-resolver.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

test("production resolver pins selected golden/account/resources and cleanup survives model/member revocation", async () => {
  const { db, people: p } = await database();
  const sql: core.Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const forks: core.ForkRequest[] = [];
  const targets: core.ProviderTarget[] = [];
  try {
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    const account = (
      await db.query<{ id: string; version: number }>(
        "select id,version from credentials where owner_id=$1 and scope='user' and kind='claude_oauth'",
        [p.owner],
      )
    ).rows[0];
    if (!golden || !account) throw Error("Actual named account/golden fixture missing.");
    await db.query("update goldens set size_policy=$2::jsonb where id=$1", [
      golden.id,
      JSON.stringify({ version: 1, golden: "large", repositories: { web: "medium" } }),
    ]);
    await db.query(
      "insert into goldens(org_id,name,visibility,owner_id,boat_snapshot_id,config) select org_id,name,'private',$2,'a'||repeat('4',62),config from goldens where id=$1",
      [golden.id, p.owner],
    );
    const choice = core.resolveModelChoice("claude", {});
    const configuration = {
      version: 1 as const,
      orgId: p.org,
      name: "selected",
      goldenId: golden.id,
      provider: "boat" as const,
      harness: "claude" as const,
      model: choice.model,
      reasoningEffort: choice.reasoningEffort,
      modelAccountId: account.id,
      repo: "example/web",
      size: "small" as const,
    };
    const provider = {
      id: "boat",
      get: async () => ({ state: "running", physicalGeneration: "native-42" }),
      observeOrchestrator: async (request: { physicalGeneration: string }) => {
        expect(request.physicalGeneration).toBe("native-42");
        return {
          physicalGeneration: "native-42",
          state: "active",
          evidence: "a".repeat(64),
          eventWatermark: 1,
          acknowledgedSequence: 1,
          nativeSessionId: null,
        };
      },
      harnesses: ["claude", "codex"],
      capabilities: { claude: { reasoningEffort: true }, codex: { reasoningEffort: true } },
      prepareNativeHarnessCwd: async () => {},
      fork: async (input: core.ForkRequest) => {
        forks.push(input);
        throw new core.ProviderError({
          provider: "boat",
          code: "invalid_request",
          message: "synthetic allocation refused",
          retryable: false,
        });
      },
    } as unknown as core.Provider;
    const selection = createOrchestratorBackendResolver({
      sql,
      encryptionKey: ENCRYPTION_KEY,
      providers: {
        resolve: async (target) => {
          targets.push(target);
          return provider;
        },
      },
      credentials: launchCredentials(core.createSqlVaultStore(sql), ENCRYPTION_KEY),
      mcpUrl: "https://armada.invalid/mcp",
      consent: async () => ({ scopes: ["worker:launch"], goldenIds: [golden.id], credentialIds: [account.id] }),
      native: () => ({
        assertPrerequisites: async () => {},
        managed: (provider) => ({
          provider,
          mcpUrl: "https://armada.invalid/mcp",
          observe: async (machine) => ({ ...machine, state: "unknown", evidence: "native:unknown" }),
          checkpointAndStop: async () => {
            throw Error("No native operation expected.");
          },
          readStopReceipt: async () => null,
        }),
      }),
    });
    const backend = await selection.resolveBackend(configuration, p.owner);
    expect(backend.projectDir).toBe("/home/user/web");
    expect(backend.selection?.model).toBe(choice.model);
    const store = new OrchestratorRuntimeStore(sql, core.reserveOrchestratorOperation);
    const reservation = await store.create({
      ownerId: p.owner,
      configuration,
      key: "create",
      skillRevision: "a".repeat(40),
    });
    await expect(backend.launch(reservation)).rejects.toThrow("synthetic allocation refused");
    expect(forks).toHaveLength(1);
    expect(forks[0]?.size).toBe("small");
    expect(forks[0]?.labels?.golden).toBe("shared");
    expect(targets[0]?.visibility).toBe("org");
    const sandbox = await core.createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: crypto.randomUUID(),
      goldenId: golden.id,
      orgId: p.org,
      ownerId: p.owner,
      harness: "claude",
      model: choice.model,
      reasoningEffort: choice.reasoningEffort,
      visibility: "private",
      status: "running",
      repositoryDir: "web",
      ...{ credentialId: account.id, credentialVersion: account.version },
    });
    await db.query("update orchestrators set sandbox_id=$2 where id=$1", [reservation.identity.id, sandbox.id]);
    reservation.identity = await store.preparing(reservation);
    await store.complete(reservation, { state: "succeeded", conversationId: "native-existing" });
    const existing = await store.read(p.owner, p.org, reservation.identity.id);
    await db.query("update goldens set config=$2::jsonb,size_policy=null where id=$1", [
      golden.id,
      JSON.stringify({
        repos: [{ url: "https://github.com/other/renamed.git", branch: "main", dir: "renamed" }],
        init: [],
      }),
    ]);
    expect((await selection.resolveBackend(configuration, p.owner, existing)).projectDir).toBe("/home/user/web");
    const resolvedCount = targets.length;
    await db.query("update credentials set status='revoked' where id=$1", [account.id]);
    await expect(selection.resolveBackend(configuration, p.owner, existing)).rejects.toThrow();
    expect(targets).toHaveLength(resolvedCount);
    const machine = {
      orchestratorId: reservation.identity.id,
      sandboxId: sandbox.id,
      providerSandboxId: sandbox.providerSandboxId,
      generation: String(sandbox.lifecycleGeneration),
    };
    await db.query("delete from members where org_id=$1 and user_id=$2", [p.org, p.owner]);
    const managed = await selection.resolveManaged(machine, {
      ownerId: p.owner,
      orgId: p.org,
      goldenId: golden.id,
      provider: "boat",
    });
    expect(managed.provider.id).toBe("boat");
    expect((await managed.observe(machine)).state).toBe("unknown");
    expect(targets.at(-1)?.sourceGoldenVisibility).toBe("org");
    expect(targets.at(-1)?.visibility).toBe("private");
    await expect(selection.resolveBackend(configuration, p.owner)).rejects.toThrow("not_found");
  } finally {
    await db.close();
  }
});
