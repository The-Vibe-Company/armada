import { describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { applyMigrations, migrationsDir, openDatabase } from "../../../scripts/db/apply.ts";
import { createMemoryAuthStore } from "../../auth/src/index.ts";
import { handleControlRequest } from "../../mcp-server/src/control.ts";
import { providerRegistry } from "../../mcp-server/src/http.ts";
import { sqlOver } from "../../mcp-server/src/sql.ts";
import helperManifest from "../helper/manifest.json";
import {
  connectGolden,
  createGoldenCreateService,
  createSqlGoldenStore,
  createSqlVaultStore,
  encryptSecret,
  type GitHubInstallationApp,
  type GoldenActor,
  GoldenBuildJobs,
  type GoldenBuildStatus,
  GoldenError,
  type Provider,
  ProviderError,
  type SandboxInfo,
  type Sql,
} from "../src/server.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const APP = { clientId: "Iv1.test", clientSecret: "github-client-secret" };

describe("createGoldenCreateService, wired to a real database", () => {
  test("refuses a caller with no GitHub connection before touching the provider or the database", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const { actor } = await fixture(db);
      const service = createGoldenCreateService({
        sql: db,
        github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP },
        installationApp: null,
      });
      const untouched: Provider = readyProvider();
      await expect(
        service.create(untouched, actor, { name: "web", visibility: "org", repos: ["acme/web"] }),
      ).rejects.toThrow(GoldenError);
      const rows = await db.query("select 1 from goldens");
      expect(rows.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  test.each(["boat", "modal"] as const)(
    "secure %s checkout persists provider-specific identity without Boat aliases",
    async (providerId) => {
      const db = await openDatabase();
      try {
        await applyMigrations(db);
        const { actor, userId } = await fixture(db);
        await connectGitHub(db, userId);
        const sshCalls: { token: string; script: string }[] = [];
        // PGlite has one connection. Route a provider's read-only validation to the active
        // transaction instead of deadlocking an independent pool read (production Bun SQL pools).
        let active: Sql | undefined;
        const sql: Sql = {
          query: (text, params) => (active ?? db).query(text, params),
          transaction: (work) =>
            db.transaction(async (tx) => {
              active = tx;
              try {
                return await work(tx);
              } finally {
                active = undefined;
              }
            }),
        };
        const serviceOptions = {
          github: { store: createSqlVaultStore(sql), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
          installationApp: null,
          fetch: fakeGitHubFetch(),
          ssh: async (
            _provider: Provider,
            input: {
              token: string;
              script: string;
              onWarning?: (warning: "skillpack_download_unavailable" | "skillpack_user_local_only") => void;
            },
          ) => {
            if (providerId === "modal") input.onWarning?.("skillpack_download_unavailable");
            sshCalls.push(input);
          },
        };
        const { maxGoldens: _capacity, backendIdentity: _identity, ...uncapped } = readyProvider();
        const provider: Provider = providerId === "modal" ? { ...uncapped, id: "modal" } : readyProvider();
        let builders = 0;
        const createBuilder = provider.createGolden;
        provider.createGolden = async (input) => {
          builders++;
          return createBuilder(input);
        };
        const modal = { workspace: "workspace-authority", environment: "main", appId: "ap-immutable" };
        const store = createSqlVaultStore(sql);
        const orgPair = { token_id: "ak-org000001", token_secret: "as-org000001" };
        let activePair = orgPair;
        for (const [scope, owner, value] of [
          ["org", actor.orgId, orgPair],
          ["user", actor.userId, { token_id: "ak-personal01", token_secret: "as-personal01" }],
        ] as const)
          await db.query("insert into credentials(scope,owner_id,kind,value_enc) values($1,$2,'modal',$3)", [
            scope,
            owner,
            await encryptSecret(JSON.stringify(value), KEY),
          ]);
        await store.setOrgBoatKey(actor.orgId, await encryptSecret("boat-test", KEY));
        const authStore = createMemoryAuthStore();
        authStore.addMembership(actor.userId, { orgId: actor.orgId, name: "Example", role: "admin" });
        const registry = providerRegistry({
          vault: store,
          encryptionKey: KEY,
          providerFor: () => {
            expect(providerId).toBe("boat");
            return provider;
          },
          modalProviderFor: (tokens, binding, context) => {
            expect(tokens).toEqual({ tokenId: activePair.token_id, tokenSecret: activePair.token_secret });
            expect(binding).toEqual(modal);
            expect(context.credentialScope).toBe("org");
            expect(context.caller.userId).toBe(actor.userId);
            return provider;
          },
        });
        const workerTargets: unknown[] = [];
        const jobs = new GoldenBuildJobs({
          sql,
          encryptionKey: KEY,
          service: serviceOptions,
          provider: (freshActor, visibility, target) => {
            expect(visibility).toBe("org");
            expect(target).toEqual({
              provider: providerId,
              orgId: actor.orgId,
              visibility: "org",
              sourceGoldenVisibility: "org",
              modal: providerId === "modal" ? modal : null,
            });
            workerTargets.push(target);
            return registry.resolve(target, { userId: freshActor.userId });
          },
        });
        let configurationCalls = 0;
        const control = {
          authStore,
          store,
          encryptionKey: KEY,
          goldenBuilds: jobs,
          providerFor: () => provider,
          supabase: {
            supabaseUrl: "https://supabase.test",
            anonKey: "anon",
            fetch: (async () => Response.json({ id: actor.userId })) as unknown as typeof fetch,
          },
          goldenTarget: async (target: Omit<import("../src/sandbox-provider.ts").ProviderTarget, "modal">) => {
            configurationCalls++;
            return { ...target, modal: providerId === "modal" ? modal : null };
          },
          providers: registry,
        };
        const request = (path: string, body: object) =>
          handleControlRequest(
            new Request(`https://armada.test/api/v1/${path}`, {
              method: "POST",
              headers: { authorization: "Bearer eyJheader.eyJpayload.signature" },
              body: JSON.stringify(body),
            }),
            control,
          );
        const response = await request("golden/create", {
          name: "web",
          provider: providerId,
          repos: ["acme/web"],
          setup: "echo setup",
          idempotencyKey: "async-build-contract-01",
        });
        expect(response?.status).toBe(202);
        const admitted = (await response?.json()) as GoldenBuildStatus;
        expect(admitted).toMatchObject({ state: "queued", provider: providerId, result: null });
        expect(builders).toBe(0);
        expect(sshCalls).toHaveLength(0);
        expect((await db.query("select id from goldens")).rows).toHaveLength(0);
        const encrypted = (
          await db.query<{ payload_enc: Uint8Array; reservation_id: string | null }>(
            "select payload_enc,reservation_id from golden_build_jobs",
          )
        ).rows[0]!;
        const payload = await import("../src/crypto.ts").then((crypto) =>
          crypto.decryptSecret(new Uint8Array(encrypted.payload_enc), KEY),
        );
        expect(JSON.parse(payload)).toMatchObject({
          provider: providerId,
          modal: providerId === "modal" ? modal : null,
        });
        expect(payload).not.toContain(orgPair.token_secret);
        expect(encrypted.reservation_id === null).toBe(providerId === "modal");
        activePair = { token_id: "ak-orgrotated01", token_secret: "as-orgrotated01" };
        await db.query("update credentials set value_enc=$2 where scope='org' and owner_id=$1 and kind='modal'", [
          actor.orgId,
          await encryptSecret(JSON.stringify(activePair), KEY),
        ]);
        expect(await jobs.runOne()).toBe(true);
        expect(workerTargets).toHaveLength(providerId === "modal" ? 2 : 1);
        expect(configurationCalls).toBe(1); // Never rederive App binding during execution.
        expect(builders).toBe(1);
        const status = await request("golden/build/status", { jobId: admitted.jobId });
        expect(status?.status).toBe(200);
        const completed = (await status?.json()) as GoldenBuildStatus;
        expect(completed).toMatchObject({
          state: "succeeded",
          provider: providerId,
          result: {
            snapshot: "golden-bx_1",
            warnings: providerId === "modal" ? ["skillpack_download_unavailable"] : [],
          },
        });
        const persistedWarning = (
          await sql.query<{ build_warnings: string[] }>(
            "select build_warnings from public.goldens where name=$1 and provider=$2",
            [completed.result?.name, providerId],
          )
        ).rows[0];
        expect(persistedWarning?.build_warnings).toEqual(
          providerId === "modal" ? ["skillpack_download_unavailable"] : [],
        );
        expect(sshCalls).toHaveLength(1);
        expect(sshCalls[0]?.token).toBe("ghu_caller_access_token");

        const row = await db.query<{
          visibility: string;
          boat_snapshot_id: string;
          boat_sandbox_id: string;
          config: { repos: { url: string; branch: string; dir: string }[]; init: string[] };
        }>(
          "select provider, modal_app_id, provider_snapshot_id, provider_sandbox_id, visibility, boat_snapshot_id, boat_sandbox_id, config, helper_receipt from goldens where name = 'web'",
        );
        expect(row.rows[0]).toMatchObject({
          visibility: "org",
          provider: providerId,
          modal_app_id: providerId === "modal" ? modal.appId : null,
          provider_snapshot_id: "golden-bx_1",
          helper_receipt: {
            version: "0.1.0",
            protocol: 1,
            digest: helperManifest.x86_64.digest,
            platform: "x86_64",
            capabilities: ["diagnose"],
            snapshotId: "golden-bx_1",
          },
          provider_sandbox_id: null,
          boat_snapshot_id: providerId === "boat" ? "golden-bx_1" : null,
          boat_sandbox_id: null,
          config: {
            repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }],
            init: ["echo setup"],
          },
        });
        const slots = await db.query("select golden_id,build_id from golden_backend_slots");
        expect(slots.rows).toHaveLength(providerId === "boat" ? 1 : 0);
        if (providerId === "boat") expect((slots.rows[0] as { build_id: string | null }).build_id).toBeNull();
      } finally {
        await db.close();
      }
    },
  );

  test("Boat capacity requires a backend identity and a second factory build is refused globally", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const { actor, userId } = await fixture(db);
      await connectGitHub(db, userId);
      const options = {
        sql: db,
        github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
        installationApp: null,
        fetch: fakeGitHubFetch(),
        ssh: async () => {},
      };
      const service = createGoldenCreateService(options);
      const noIdentity = readyProvider();
      delete noIdentity.backendIdentity;
      await expect(
        service.create(noIdentity, actor, { name: "missing-id", visibility: "org", repos: ["acme/web"] }),
      ).rejects.toThrow("backend identity");
      await service.create(readyProvider(), actor, { name: "one", visibility: "org", repos: ["acme/web"] });
      const anotherFactory = createGoldenCreateService(options);
      await expect(
        anotherFactory.create(readyProvider(), actor, { name: "two", visibility: "org", repos: ["acme/web"] }),
      ).rejects.toThrow("capacity");
      expect((await db.query("select 1 from goldens")).rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  test.each([
    { code: "ERR_POSTGRES_SERVER_ERROR", errno: "P0002", expected: "P0002" },
    { code: "23514", errno: undefined, expected: "23514" },
    { code: "NAMEZ", errno: undefined, expected: "unavailable" },
  ])(
    "factory rolls back on finalize failure and redacts driver diagnostics ($expected)",
    async ({ code, errno, expected }) => {
      const db = await openDatabase();
      const logs = spyOn(console, "error").mockImplementation(() => {});
      try {
        await applyMigrations(db);
        const { actor, userId } = await fixture(db);
        await connectGitHub(db, userId);
        const original = db.query.bind(db);
        const originalTransaction = db.transaction?.bind(db);
        // Failure injection through the transaction client used by the real factory SQL path.
        db.transaction = (async (work) =>
          originalTransaction!(async (tx) => {
            const originalTx = tx.query.bind(tx);
            tx.query = (async (text: string, params?: unknown[]) => {
              if (text.includes("finalize_golden_backend_slot"))
                throw Object.assign(new Error("private-provider-output"), { code, errno, detail: "private-detail" });
              return originalTx(text, params);
            }) as typeof tx.query;
            return work(tx);
          })) as typeof db.transaction;
        const deleted: string[] = [];
        const provider = {
          ...readyProvider(),
          deleteSnapshot: async (name: string) => {
            deleted.push(name);
          },
        };
        const service = createGoldenCreateService({
          sql: db,
          github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
          installationApp: null,
          fetch: fakeGitHubFetch(),
          ssh: async () => {},
        });
        await expect(
          service.create(provider, actor, { name: "bad-finalize", visibility: "org", repos: ["acme/web"] }),
        ).rejects.toMatchObject({ code: "build_failed" });
        expect((await original("select 1 from goldens")).rows).toHaveLength(0);
        expect((await original("select 1 from golden_backend_slots")).rows).toHaveLength(0);
        expect(deleted).toEqual(["golden-bx_1"]);
        const diagnostics = logs.mock.calls.map(([line]) => JSON.parse(String(line)));
        expect(diagnostics.filter((entry) => entry.event === "golden_persist_failed")).toEqual([
          { event: "golden_persist_failed", step: "slot_finalize", sqlState: expected },
        ]);
        expect(diagnostics.find((entry) => entry.event === "golden_build_failed")?.code).toBe(
          expected === "unavailable" ? "unknown" : "build_failed",
        );
        for (const value of ["private-provider-output", "private-detail", "NAMEZ"])
          expect(JSON.stringify(diagnostics)).not.toContain(value);
      } finally {
        logs.mockRestore();
        await db.close();
      }
    },
  );

  test("with GITHUB_APP_PRIVATE_KEY configured, checkout uses a scoped installation token and revokes it", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const { actor, userId } = await fixture(db);
      await connectGitHub(db, userId);
      const installationApp: GitHubInstallationApp = {
        appId: "1",
        privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      };
      const revoked: string[] = [];
      const fetchImpl = fakeGitHubFetch(revoked);
      const sshCalls: { token: string }[] = [];
      const service = createGoldenCreateService({
        sql: db,
        github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fetchImpl },
        installationApp,
        fetch: fetchImpl,
        ssh: async (_provider, input) => {
          sshCalls.push(input);
        },
      });
      await service.create(readyProvider(), actor, { name: "web", visibility: "private", repos: ["acme/web"] });
      expect(sshCalls[0]?.token).toBe("ghs_scoped_installation_token");
      expect(revoked).toEqual(["ghs_scoped_installation_token"]);
    } finally {
      await db.close();
    }
  });

  test("a fail-closed scan stops the build before any snapshot or database row", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const { actor, userId } = await fixture(db);
      await connectGitHub(db, userId);
      const stops: string[] = [];
      const provider: Provider = {
        ...readyProvider(),
        exec: async () => ({
          detached: false,
          exitCode: 97,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
        }),
        stop: async ({ sandboxId }) => {
          stops.push(sandboxId);
        },
      };
      const service = createGoldenCreateService({
        sql: db,
        github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
        installationApp: null,
        fetch: fakeGitHubFetch(),
        ssh: async () => {},
      });
      await expect(
        service.create(provider, actor, { name: "web", visibility: "org", repos: ["acme/web"] }),
      ).rejects.toThrow(GoldenError);
      expect(stops).toEqual(["bx_1"]);
      const rows = await db.query("select 1 from goldens");
      expect(rows.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});

test("rebuild retains last-good artifacts/config through scan, snapshot and SQL failures, then restores the committed revision", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    const { actor, userId } = await fixture(db);
    await connectGitHub(db, userId);
    let failure = "";
    let generation = 0;
    const artifacts = new Map<
      string,
      { source: string; content: number; status: "ready" | "failed"; fingerprint?: string }
    >();
    const machines = new Map<string, { content: number; stopped: boolean }>();
    const deleted: string[] = [];
    let next = 0;
    let blockedOldMaster: string | undefined;
    const start = (content: number): SandboxInfo => {
      const id = `machine-${++next}`;
      machines.set(id, { content, stopped: false });
      return { id, name: "builder", state: "ready", providerState: "ready", labels: {} };
    };
    const provider: Provider = {
      ...readyProvider(),
      managementIdentity: async () => ({ scope: "org", ownerId: actor.orgId }),
      createGolden: async () => start(++generation),
      snapshot: async ({ name, sandboxId }) => {
        artifacts.set(name, {
          source: sandboxId,
          content: machines.get(sandboxId)!.content,
          status: failure === "snapshot" ? "failed" : "ready",
        });
        // Request can fail after the remote artifact was created.
        if (failure === "request") throw new Error("snapshot request lost");
        return { name, status: artifacts.get(name)!.status, sourceSandboxId: sandboxId };
      },
      getSnapshot: async (name) => {
        const artifact = artifacts.get(name);
        if (!artifact)
          throw new ProviderError({
            provider: "boat",
            code: "not_found",
            message: "absent artifact",
            retryable: false,
          });
        return {
          name,
          status: artifact.status,
          sourceSandboxId: artifact.source,
          artifactId: artifact.fingerprint ?? "disk-" + name,
        };
      },
      deleteSnapshot: async (name) => {
        deleted.push(name);
        artifacts.delete(name);
      },
      stop: async ({ sandboxId }) => {
        if (failure === "old-stop" && sandboxId === blockedOldMaster) throw new Error("uncertain old stop");
        machines.get(sandboxId)!.stopped = true;
      },
      get: async (id) => {
        const machine = machines.get(id);
        if (!machine)
          throw new ProviderError({ provider: "boat", code: "not_found", message: "absent", retryable: false });
        return { id, name: "master", state: machine.stopped ? "stopped" : "ready", providerState: "", labels: {} };
      },
      fork: async ({ from, noEnv }) => {
        expect(noEnv).toBe(true);
        const artifact = artifacts.get(from);
        if (!artifact || artifact.status !== "ready") throw new Error("unusable snapshot");
        return start(artifact.content);
      },
      exec: async ({ command }) => ({
        detached: false,
        exitCode: failure === "scan" ? 97 : 0,
        stdout: command.includes("/helper/0.1.0/armada-helper") ? helperOutput : "",
        stderr: "",
        timedOut: false,
        truncated: false,
      }),
    };
    const transaction = db.transaction.bind(db);
    db.transaction = (async (work) => {
      let finalized = false;
      const result = await transaction(async (tx) => {
        const query = tx.query.bind(tx);
        tx.query = (async (sql: string, params?: unknown[]) => {
          if (sql.includes("finalize_golden_backend_slot")) finalized = true;
          if (failure === "persist" && sql.includes("finalize_golden_backend_slot"))
            throw new Error("injected finalize failure");
          return query(sql, params);
        }) as typeof tx.query;
        return work(tx);
      });
      if (failure === "ack" && finalized) throw new Error("commit acknowledgement lost");
      return result;
    }) as typeof db.transaction;
    const service = createGoldenCreateService({
      sql: db,
      github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
      installationApp: null,
      fetch: fakeGitHubFetch(),
      ssh: async () => {},
    });
    const store = createSqlGoldenStore(db);
    const input = { name: "web", visibility: "org" as const, repos: ["acme/web"], setup: "echo old" };
    const first = await service.create(provider, actor, input);
    const before = (await store.findByName(actor.orgId, "web"))[0]!;
    expect(before.providerSandboxId).toBeNull();
    expect(machines.get(artifacts.get(first.snapshot)!.source)?.stopped).toBe(true);
    const unchanged = (await db.query("select * from goldens")).rows;
    const binding = (await db.query("select golden_id,backend_id,org_id,owner_id from golden_backend_slots")).rows;
    for (const stage of ["scan", "snapshot", "request", "persist"]) {
      failure = stage;
      await expect(
        service.create(provider, actor, { ...input, setup: "echo new", existingGolden: before }),
      ).rejects.toThrow();
      expect((await db.query("select * from goldens")).rows).toEqual(unchanged);
      expect((await db.query("select golden_id,backend_id,org_id,owner_id from golden_backend_slots")).rows).toEqual(
        binding,
      );
      expect([...artifacts.keys()]).toEqual([first.snapshot]);
      expect(deleted).not.toContain(first.snapshot);
      expect((await db.query("select id from golden_snapshot_retirements")).rows).toEqual([]);
      expect([...machines.values()].every((machine) => machine.stopped)).toBe(true);
    }
    failure = "";
    const updated = await service.create(provider, actor, { ...input, setup: "echo new", existingGolden: before });
    expect(updated.snapshot).not.toBe(first.snapshot);
    expect(artifacts.has(first.snapshot)).toBe(true);
    const after = (await store.findByName(actor.orgId, "web"))[0]!;
    expect(after.id).toBe(before.id);
    expect(after.providerSnapshotId).toBe(updated.snapshot);
    expect(after.config.init).toEqual(["echo new"]);
    expect(after.providerSandboxId).toBeNull();
    expect((await db.query("select old_snapshot,new_snapshot from golden_snapshot_retirements")).rows).toEqual([
      { old_snapshot: first.snapshot, new_snapshot: updated.snapshot },
    ]);
    expect((await db.query("select golden_id,backend_id,org_id,owner_id from golden_backend_slots")).rows).toEqual(
      binding,
    );
    const connected = await connectGolden(provider, store, actor, "web");
    expect(machines.get(connected.sandbox.id)?.content).toBe(artifacts.get(updated.snapshot)?.content);
    expect(machines.get(connected.sandbox.id)?.stopped).toBe(false);
    // Stopped masters restore from the new revision, not the cleaned-up builder.
    await provider.stop({ sandboxId: connected.sandbox.id });
    const restored = await connectGolden(provider, store, actor, "web");
    expect(restored.sandbox.id).not.toBe(connected.sandbox.id);
    expect(machines.get(restored.sandbox.id)?.content).toBe(artifacts.get(updated.snapshot)?.content);
    // A failed old-master stop must leave that active master canonical and retrievable.
    const active = (await store.findByName(actor.orgId, "web"))[0]!;
    blockedOldMaster = active.providerSandboxId!;
    failure = "old-stop";
    await expect(service.create(provider, actor, { ...input, existingGolden: active })).rejects.toThrow(
      "remains canonical",
    );
    expect((await store.findByName(actor.orgId, "web"))[0]?.providerSandboxId).toBe(blockedOldMaster);
    expect((await provider.get(blockedOldMaster)).state).toBe("ready");
    expect(artifacts.has(active.providerSnapshotId!)).toBe(true);
    // Rollback after quiescence retains the old stopped master reference and its last-good artifact.
    failure = "persist";
    await expect(service.create(provider, actor, { ...input, existingGolden: active })).rejects.toMatchObject({
      code: "build_failed",
    });
    expect((await store.findByName(actor.orgId, "web"))[0]?.providerSandboxId).toBe(blockedOldMaster);
    expect((await provider.get(blockedOldMaster)).state).toBe("stopped");
    failure = "";
    const reopened = await connectGolden(provider, store, actor, "web");
    expect((await provider.get(reopened.sandbox.id)).state).toBe("ready");
    const beforeRetire = (await store.findByName(actor.orgId, "web"))[0]!;
    await service.create(provider, actor, { ...input, existingGolden: beforeRetire });
    expect((await store.findByName(actor.orgId, "web"))[0]?.providerSandboxId).toBeNull();
    expect((await provider.get(reopened.sandbox.id)).state).toBe("stopped");
    expect([...machines.values()].every((machine) => machine.stopped)).toBe(true);
    // An ambiguous commit error must never delete an artifact the database actually committed.
    failure = "ack";
    const current = (await store.findByName(actor.orgId, "web"))[0]!;
    await expect(service.create(provider, actor, { ...input, existingGolden: current })).rejects.toThrow(
      "publication could not be confirmed",
    );
    const committed = (await store.findByName(actor.orgId, "web"))[0]!;
    expect(committed.providerSnapshotId).not.toBe(updated.snapshot);
    expect(artifacts.has(committed.providerSnapshotId!)).toBe(true);
    expect(artifacts.has(updated.snapshot)).toBe(true);
    expect(
      (
        await db.query("select new_snapshot from golden_snapshot_retirements where old_snapshot=$1", [
          current.providerSnapshotId,
        ])
      ).rows,
    ).toEqual([{ new_snapshot: committed.providerSnapshotId }]);
    failure = "";
    let integrityFailure = false;
    const jobs = new GoldenBuildJobs({
      sql: db,
      encryptionKey: KEY,
      service: {
        github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
        installationApp: null,
        fetch: fakeGitHubFetch(),
        ssh: async () => {
          if (integrityFailure)
            throw new GoldenError("build_failed", "closed integrity failure", {
              safeReason: "skillpack_integrity_failed",
            });
        },
      },
      provider: async () => provider,
    });
    const job = await jobs.admit(provider, actor, { ...input, existingGolden: committed }, crypto.randomUUID());
    await jobs.runOne();
    expect((await jobs.status(actor.userId, job.jobId)).state).toBe("succeeded");
    const changed = (await store.findByName(actor.orgId, "web"))[0]!;
    integrityFailure = true;
    const rejectedBuild = await jobs.admit(provider, actor, { ...input, existingGolden: changed }, crypto.randomUUID());
    await jobs.runOne();
    expect(await jobs.status(actor.userId, rejectedBuild.jobId)).toMatchObject({
      state: "failed",
      failureReason: "skillpack_integrity_failed",
      result: null,
    });
    expect((await store.findByName(actor.orgId, "web"))[0]?.providerSnapshotId).toBe(changed.providerSnapshotId);
    artifacts.get(changed.providerSnapshotId!)!.fingerprint = "changed-outside-managed-namespace";
    const recovered = await service.create(provider, actor, { ...input, existingGolden: changed });
    expect(recovered.snapshot).not.toBe(changed.providerSnapshotId);
    expect(artifacts.has(changed.providerSnapshotId!)).toBe(true);
    expect(deleted).not.toContain(changed.providerSnapshotId!);
    expect(
      (
        await db.query<{ artifact_id: string }>(
          "select artifact_id from golden_snapshot_publications where snapshot=$1",
          [changed.providerSnapshotId],
        )
      ).rows[0]?.artifact_id,
    ).toBe("disk-" + changed.providerSnapshotId);
    const live = (await store.findByName(actor.orgId, "web"))[0]!;
    const collision = crypto.randomUUID(),
      label = `golden-r-${collision}`;
    artifacts.set(label, { source: "foreign-source", content: 999, status: "ready" });
    const uuid = spyOn(crypto, "randomUUID").mockReturnValue(collision);
    try {
      await expect(service.create(provider, actor, { ...input, existingGolden: live })).rejects.toThrow();
      expect(artifacts.get(label)?.source).toBe("foreign-source");
      expect(deleted).not.toContain(label);
      artifacts.delete(label); // The persisted namespace claim still forbids reuse after upstream disappearance.
      await expect(
        db.query(
          `insert into golden_snapshot_publications(id,golden_id,provider,backend_id,snapshot,target,manager_id)
        select gen_random_uuid(),golden_id,provider,backend_id,snapshot,target,manager_id from golden_snapshot_publications where snapshot=$1`,
          [label],
        ),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "golden_snapshot_publications_provider_backend_id_snapshot_key",
      });
      expect(artifacts.has(label)).toBe(false);
      expect(deleted).not.toContain(label);
      expect((await store.findByName(actor.orgId, "web"))[0]?.providerSnapshotId).toBe(live.providerSnapshotId);
    } finally {
      uuid.mockRestore();
    }
  } finally {
    await db.close();
  }
});

async function fixture(db: Sql): Promise<{ actor: GoldenActor; userId: string }> {
  const org = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await db.query("insert into auth.users (id) values ($1)", [userId]);
  await db.query("insert into orgs (id, name) values ($1, 'Example')", [org]);
  await db.query("insert into members (org_id, user_id, role) values ($1, $2, 'admin')", [org, userId]);
  return { actor: { userId, orgId: org, role: "admin" }, userId };
}

async function connectGitHub(db: Sql, userId: string): Promise<void> {
  await db.query(
    "insert into github_connections (user_id, github_id, login, refresh_token_enc) values ($1, 583231, 'octocat', $2)",
    [userId, await encryptSecret("ghr_refresh_octocat", KEY)],
  );
}

/** GitHub's REST surface a golden create needs: the OAuth refresh, `/user`, installations, a repo, and (optionally) a scoped installation token. */
function fakeGitHubFetch(revoked: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({
        access_token: "ghu_caller_access_token",
        refresh_token: "ghr_refresh_octocat_1",
        expires_in: 28_800,
        refresh_token_expires_in: 15_811_200,
      });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: 583231, login: "octocat", name: null });
    if (url.includes("/user/installations")) {
      return Response.json({
        installations: [
          {
            id: 9,
            app_id: 1,
            app_slug: "armada",
            account: { login: "acme", type: "Organization" },
            repository_selection: "all",
          },
        ],
      });
    }
    if (url === "https://api.github.com/repos/acme/web") {
      return Response.json({ id: 7, name: "web", default_branch: "main", owner: { login: "acme" }, private: false });
    }
    if (url.includes("/access_tokens")) {
      return Response.json({
        token: "ghs_scoped_installation_token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url === "https://api.github.com/installation/token" && init?.method === "DELETE") {
      revoked.push("ghs_scoped_installation_token");
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
}

function readyProvider(): Provider {
  let next = 0;
  const sandbox = (): SandboxInfo => ({
    id: `bx_${++next}`,
    name: "box",
    state: "ready",
    providerState: "ready",
    labels: {},
  });
  const ok = { detached: false as const, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
  return {
    id: "boat",
    maxGoldens: 1,
    backendIdentity: async () => ({ id: "boat-account" }),
    harnesses: ["claude", "codex"],
    capabilities: { claude: caps(), codex: caps() },
    createGolden: async () => sandbox(),
    snapshot: async ({ name }) => ({ name, status: "ready" }),
    getSnapshot: async () => {
      throw new ProviderError({ provider: "boat", code: "not_found", message: "absent snapshot", retryable: false });
    },
    deleteSnapshot: async () => {},
    fork: async () => sandbox(),
    get: async () => sandbox(),
    list: async () => ({ items: [], cursor: null }),
    prompt: async () => ({ promptId: "p", conversationId: "c", status: "queued" }),
    getPrompt: async () => ({ promptId: "p", status: "finished", done: true }),
    steer: async () => ({ conversationId: "c", promptId: "p" }),
    interrupt: async () => {},
    sshKey: async () => ({ sshEndpoint: "ssh.test:22", hostKey: "ssh-ed25519 AAAA" }),
    exec: async ({ command }) =>
      command.includes("/helper/0.1.0/armada-helper") ? { ...ok, stdout: helperOutput } : ok,
    events: async () => ({ events: [], hasMore: false }),
    stop: async () => {},
    delete: async () => ({ status: "pending" }),
  };
}

function caps() {
  return {
    steer: "none" as const,
    interrupt: false,
    resume: false,
    parallelConversations: false,
    reasoningEffort: false,
    fast: false,
    streamsPartials: false,
    toolEvents: false,
    approvals: false,
  };
}

// A single PGlite connection cannot observe an uncommitted transaction from another session.
// This test runs on actual PostgreSQL using promise barriers, with no wall-clock ordering guesses.
test.skipIf(!process.env.ARMADA_TEST_POSTGRES_URL)(
  "invisible in-flight COMMIT cannot authorize deleting a ready golden artifact",
  async () => {
    const configured = process.env.ARMADA_TEST_POSTGRES_URL!;
    const admin = new Bun.SQL(configured);
    const name = `golden_review_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`create database "${name}"`);
    const url = new URL(configured);
    url.pathname = `/${name}`;
    const client = new Bun.SQL(url.href);
    const sql = sqlOver({
      unsafe: (text, params) => client.unsafe(text, params),
      begin: (work) => client.begin((tx) => work({ unsafe: (text, params) => tx.unsafe(text, params) })),
    });
    let finish!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let callbackDone!: () => void;
    const callbackFinished = new Promise<void>((resolve) => {
      callbackDone = resolve;
    });
    let pendingCommit: Promise<unknown> | undefined;
    let attempt: Promise<void> | undefined;
    try {
      const prereq = (await Bun.file(join(migrationsDir, "../../scripts/db/supabase-prereq.sql")).text()).replace(
        /^create role [^;]+;/gm,
        (command) => `do $$ begin ${command} exception when duplicate_object then null; end $$;`,
      );
      await client.unsafe(prereq);
      for (const file of (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort())
        await client.unsafe(await Bun.file(join(migrationsDir, file)).text());
      const { actor, userId } = await fixture(sql);
      await connectGitHub(sql, userId);
      const artifacts = new Set<string>();
      const deleted: string[] = [];
      let deletedArtifact!: () => void;
      const deletionObserved = new Promise<void>((resolve) => {
        deletedArtifact = resolve;
      });
      const provider: Provider = {
        ...readyProvider(),
        snapshot: async ({ name, sandboxId }) => {
          artifacts.add(name);
          return { name, sourceSandboxId: sandboxId, status: "ready" };
        },
        deleteSnapshot: async (name) => {
          deleted.push(name);
          artifacts.delete(name);
          deletedArtifact();
        },
      };
      const ambiguous: Sql = {
        query: sql.query,
        async transaction(work) {
          pendingCommit = sql.transaction!(async (tx) => {
            const result = await work(tx);
            callbackDone();
            await commitGate;
            return result;
          });
          // The real transaction callback has written/finalized, but COMMIT is still gated.
          await callbackFinished;
          throw new Error("transport disconnected before COMMIT acknowledgement");
        },
      };
      const service = createGoldenCreateService({
        sql: ambiguous,
        github: { store: createSqlVaultStore(sql), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
        installationApp: null,
        fetch: fakeGitHubFetch(),
        ssh: async () => {},
      });
      let failure: unknown;
      attempt = service.create(provider, actor, { name: "late", visibility: "org", repos: ["acme/web"] }).then(
        () => {},
        (error: unknown) => {
          failure = error;
        },
      );
      // Baseline cleanup can then block releasing the uncommitted slot. Observe deletion itself
      // rather than waiting for that deadlock or using wall-clock sleeps to release COMMIT.
      await Promise.race([attempt, deletionObserved]);
      // Independent real connection sees no row: that absence is NOT evidence of rollback.
      expect((await sql.query("select id from goldens")).rows).toHaveLength(0);
      expect(deleted).toEqual([]);
      expect(artifacts.has("golden-bx_1")).toBe(true);
      expect(failure).toMatchObject({ code: "conflict" });
      expect(String(failure)).toContain("reconcile the in-flight transaction");
      finish();
      await pendingCommit;
      const committed = await sql.query<{ provider_snapshot_id: string }>("select provider_snapshot_id from goldens");
      expect(committed.rows[0]?.provider_snapshot_id).toBe("golden-bx_1");
      expect(artifacts.has(committed.rows[0]!.provider_snapshot_id)).toBe(true);
      const slots = await sql.query<{ golden_id: string; build_id: string | null }>(
        "select golden_id,build_id from golden_backend_slots",
      );
      expect(slots.rows[0]?.golden_id).toBeTruthy();
      expect(slots.rows[0]?.build_id).toBeNull();
      // The independent known-negative case is a callback error acknowledged after actual rollback.
      // Keep loser cleanup: prior artifact and finalized binding must survive, new attempt is reclaimed.
      const prior = (await createSqlGoldenStore(sql).findByName(actor.orgId, "late"))[0]!;
      const rollbackSql: Sql = {
        query: sql.query,
        transaction: (work) =>
          sql.transaction!(async (tx) =>
            work({
              query: async (text, params) => {
                if (text.includes("finalize_golden_backend_slot")) throw new Error("known rollback callback");
                return tx.query(text, params);
              },
            }),
          ),
      };
      const knownLoser = createGoldenCreateService({
        sql: rollbackSql,
        github: { store: createSqlVaultStore(sql), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
        installationApp: null,
        fetch: fakeGitHubFetch(),
        ssh: async () => {},
      });
      await expect(
        knownLoser.create(provider, actor, {
          name: "late",
          visibility: "org",
          repos: ["acme/web"],
          existingGolden: prior,
        }),
      ).rejects.toMatchObject({ code: "build_failed" });
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).not.toBe(prior.providerSnapshotId);
      expect(artifacts.has(prior.providerSnapshotId!)).toBe(true);
      expect((await createSqlGoldenStore(sql).findByName(actor.orgId, "late"))[0]?.providerSnapshotId).toBe(
        prior.providerSnapshotId,
      );
      expect(
        (await sql.query<{ build_id: string | null }>("select build_id from golden_backend_slots")).rows[0]?.build_id,
      ).toBeNull();
    } finally {
      finish();
      await pendingCommit?.catch(() => {});
      await attempt;
      await client.close();
      await admin.unsafe(`drop database "${name}" with (force)`);
      await admin.close();
    }
  },
);

test.each(["delayed", "timeout", "failed", "unknown"] as const)(
  "rebuild keeps its old canonical master until a confirmed stop (%s)",
  async (mode) => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const { actor, userId } = await fixture(db);
      await connectGitHub(db, userId);
      const remote = new Map<string, "running" | "stopped" | "failed">();
      const artifacts = new Set<string>();
      const deleted: string[] = [];
      let n = 0;
      let oldMaster: string | undefined;
      let stopAcknowledged = false;
      let unknown = mode === "unknown";
      const allocate = (): SandboxInfo => {
        const id = `remote-${++n}`;
        remote.set(id, "running");
        return { id, name: id, state: "ready", providerState: "active", labels: {} };
      };
      const provider: Provider = {
        ...readyProvider(),
        createGolden: async () => allocate(),
        fork: async () => allocate(),
        snapshot: async ({ name, sandboxId }) => {
          artifacts.add(name);
          return { name, sourceSandboxId: sandboxId, status: "ready" };
        },
        deleteSnapshot: async (name) => {
          deleted.push(name);
          artifacts.delete(name);
        },
        stop: async ({ sandboxId }) => {
          if (sandboxId === oldMaster) {
            stopAcknowledged = true;
            if (mode === "failed") remote.set(sandboxId, "failed");
            // Acknowledgement deliberately does not make the remote machine stopped.
          } else remote.set(sandboxId, "stopped");
        },
        get: async (id) => {
          if (id === oldMaster && stopAcknowledged && unknown) {
            unknown = false;
            throw new ProviderError({
              provider: "boat",
              code: "unavailable",
              retryable: true,
              message: "observation unavailable",
            });
          }
          return {
            id,
            name: id,
            state: remote.get(id) === "stopped" ? "stopped" : remote.get(id) === "failed" ? "failed" : "ready",
            providerState: remote.get(id)!,
            labels: {},
          };
        },
      };
      const service = createGoldenCreateService({
        sql: db,
        github: { store: createSqlVaultStore(db), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
        installationApp: null,
        fetch: fakeGitHubFetch(),
        ssh: async () => {},
      });
      const input = { name: "retirement", visibility: "org" as const, repos: ["acme/web"] };
      const first = await service.create(provider, actor, input);
      const store = createSqlGoldenStore(db);
      oldMaster = (await connectGolden(provider, store, actor, input.name)).sandbox.id;
      const prior = (await store.findByName(actor.orgId, input.name))[0]!;
      let waits = 0;
      const attempt = service.create(
        provider,
        actor,
        { ...input, existingGolden: prior },
        {
          sandboxPolls: 3,
          sleep: async () => {
            waits++;
            const canonical = (await store.findByName(actor.orgId, input.name))[0]!;
            expect(canonical.providerSandboxId).toBe(oldMaster!);
            expect(canonical.providerSnapshotId).toBe(first.snapshot);
            if (mode === "delayed" && waits === 2) remote.set(oldMaster!, "stopped");
          },
        },
      );
      if (mode === "delayed") {
        await attempt;
        expect(waits).toBe(2);
        expect(remote.get(oldMaster)).toBe("stopped");
        expect((await store.findByName(actor.orgId, input.name))[0]?.providerSandboxId).toBeNull();
        expect((await store.findByName(actor.orgId, input.name))[0]?.providerSnapshotId).not.toBe(first.snapshot);
      } else {
        await expect(attempt).rejects.toMatchObject({ code: "conflict" });
        const canonical = (await store.findByName(actor.orgId, input.name))[0]!;
        expect(canonical.providerSandboxId).toBe(oldMaster);
        expect(canonical.providerSnapshotId).toBe(first.snapshot);
        expect((await provider.get(oldMaster)).id).toBe(oldMaster);
        if (mode === "timeout") expect(waits).toBe(2);
      }
      expect(stopAcknowledged).toBe(true);
      expect(artifacts.has(first.snapshot)).toBe(true);
      expect(deleted).not.toContain(first.snapshot);
    } finally {
      await db.close();
    }
  },
);

test.skipIf(!process.env.ARMADA_TEST_POSTGRES_URL)(
  "PostgreSQL concurrent rebuild publications commit exactly one replacement/outbox and cleanup failure cannot undo success",
  async () => {
    const a = new Bun.SQL(process.env.ARMADA_TEST_POSTGRES_URL!, { max: 2 });
    const b = new Bun.SQL(process.env.ARMADA_TEST_POSTGRES_URL!, { max: 2 });
    const sqlA = sqlOver(a),
      sqlB = sqlOver(b);
    try {
      const { actor, userId } = await fixture(sqlA);
      await connectGitHub(sqlA, userId);
      const snapshots = new Map<string, { source: string }>(),
        machines = new Map<string, boolean>();
      const deleted: string[] = [];
      let ordinal = 0,
        refuse: string | undefined;
      const provider: Provider = {
        ...readyProvider(),
        backendIdentity: async () => ({ id: "publication-" + actor.orgId }),
        managementIdentity: async () => ({ scope: "org", ownerId: actor.orgId }),
        createGolden: async () => {
          const id = "builder-" + actor.orgId + "-" + ++ordinal;
          machines.set(id, false);
          return { id, name: id, state: "ready", providerState: "ready", labels: {} };
        },
        snapshot: async ({ name, sandboxId }) => {
          snapshots.set(name, { source: sandboxId });
          return { name, status: "ready", sourceSandboxId: sandboxId, artifactId: "artifact-" + name };
        },
        getSnapshot: async (name) => {
          const row = snapshots.get(name);
          if (!row)
            throw new ProviderError({ provider: "boat", code: "not_found", message: "absent", retryable: false });
          return { name, status: "ready", sourceSandboxId: row.source, artifactId: "artifact-" + name };
        },
        get: async (id) => ({
          id,
          name: id,
          state: machines.get(id) ? "stopped" : "ready",
          providerState: "ready",
          labels: {},
        }),
        stop: async ({ sandboxId }) => {
          machines.set(sandboxId, true);
        },
        deleteSnapshot: async (name) => {
          deleted.push(name);
          if (name === refuse)
            throw new ProviderError({ provider: "boat", code: "forbidden", message: "refused", retryable: false });
          snapshots.delete(name);
        },
      };
      const service = (sql: Sql) =>
        createGoldenCreateService({
          sql,
          github: { store: createSqlVaultStore(sql), encryptionKey: KEY, app: APP, fetch: fakeGitHubFetch() },
          installationApp: null,
          fetch: fakeGitHubFetch(),
          ssh: async () => {},
        });
      const input = { name: "web", visibility: "org" as const, repos: ["acme/web"] };
      const first = await service(sqlA).create(provider, actor, input);
      const before = (await createSqlGoldenStore(sqlA).findByName(actor.orgId, "web"))[0]!;
      const results = await Promise.allSettled([
        service(sqlA).create(provider, actor, { ...input, existingGolden: before }),
        service(sqlB).create(provider, actor, { ...input, existingGolden: before }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const current = (await createSqlGoldenStore(sqlA).findByName(actor.orgId, "web"))[0]!;
      expect(current.providerSnapshotId).not.toBe(first.snapshot);
      expect(
        (
          await sqlA.query("select old_snapshot,new_snapshot from golden_snapshot_retirements where golden_id=$1", [
            current.id,
          ])
        ).rows,
      ).toEqual([{ old_snapshot: first.snapshot, new_snapshot: current.providerSnapshotId }]);
      expect(
        (await sqlA.query("select build_id from golden_backend_slots where golden_id=$1", [current.id])).rows,
      ).toEqual([{ build_id: null }]);
      expect(deleted).not.toContain(first.snapshot);
      refuse = first.snapshot;
      const { GoldenSnapshotRetirements } = await import("../src/golden-snapshot-retirement.ts");
      const worker = new GoldenSnapshotRetirements({ sql: sqlA, encryptionKey: KEY, provider: async () => provider });
      await worker.runOne();
      expect((await createSqlGoldenStore(sqlA).findByName(actor.orgId, "web"))[0]?.providerSnapshotId).toBe(
        current.providerSnapshotId,
      );
      expect(snapshots.has(first.snapshot)).toBe(true);
      expect(snapshots.has(current.providerSnapshotId!)).toBe(true);
      refuse = undefined;
      await sqlA.query(
        "update golden_snapshot_retirements set next_attempt_at=now()-interval '1 second' where golden_id=$1",
        [current.id],
      );
      await worker.runOne();
      expect(snapshots.has(first.snapshot)).toBe(false);
      expect(snapshots.has(current.providerSnapshotId!)).toBe(true);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  },
);

const helperOutput = `x86_64\n${helperManifest.x86_64.digest}  /home/user/.local/share/armada/helper/0.1.0/armada-helper\n{"version":"0.1.0","protocol":1,"capabilities":["diagnose"]}\n`;
