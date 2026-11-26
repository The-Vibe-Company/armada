import { expect, spyOn, test } from "bun:test";
import { encryptSecret, type ProviderTarget, type Sql } from "@armada/core/server";
import { AppService, ModalClient } from "modal";
import type { Job, JobContext } from "./jobs/runner.ts";
import type { ModalArtifactBinding } from "./modal-artifact-cache.ts";
import { createModalIntegration } from "./modal-integration.ts";

test("the server's stored Modal provider refuses an unenrolled compute record", async () => {
  const encryptionKey = Buffer.alloc(32).toString("base64");
  const valueEnc = await encryptSecret(
    ["ak", "as"].map((prefix) => [prefix, "fixture0"].join("-")).join(" "),
    encryptionKey,
  );
  const caller = { userId: "owner" };
  const target: ProviderTarget = {
    provider: "modal",
    orgId: "org",
    visibility: "org",
    modal: { appId: "app", workspace: "app:app", environment: "main" },
  };
  const modal = createModalIntegration({
    encryptionKey,
    publicUrl: "https://armada.example",
    vault: {
      async credentials() {
        return [{ kind: "modal", status: "active", valueEnc }];
      },
      async orgBoatKey() {
        return null;
      },
    },
    sql: {
      async query<T>(statement: string) {
        let row: unknown;
        if (statement.includes("from public.modal_server_apps")) {
          row = { app_name: "armada-org", authority_scope: "org", authority_owner_id: target.orgId };
        } else if (statement.includes("from public.members")) {
          row = {};
        } else if (statement.includes("from public.modal_machines")) {
          row = { record: { info: { id: "machine", state: "ready" }, phase: "active", generation: 1 } };
        } else {
          throw new Error("Unexpected SQL during a stored Modal read.");
        }
        return { rows: [row as T], rowCount: 1 };
      },
    },
  });
  const provider = await modal.launchProviderFor(target, caller);
  await expect(provider.get("machine")).rejects.toThrow("This Modal connection requires Armada runtime enrolment.");
});

test("Modal machine clients are reused per credential slot, invalidated on token change, warmed on launchJob, and closed on drain", async () => {
  const encryptionKey = Buffer.alloc(32).toString("base64");
  const encodeTokens = (suffix: string) =>
    encryptSecret(["ak", "as"].map((prefix) => [prefix, suffix].join("-")).join(" "), encryptionKey);
  let activeTokens = await encodeTokens("fixture1");
  const [sandboxId, launchJobId, orgId, ownerId] = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
  let activeController = new AbortController();
  let openedInRun = false;
  const fromNameSpy = spyOn(AppService.prototype, "fromName");
  const closeSpy = spyOn(ModalClient.prototype, "close");

  try {
    const sql: Sql = {
      async query<T>(statement: string) {
        if (statement.includes("as checkpoint")) return { rows: [{ checkpoint: null } as T] };
        if (statement.includes("with locked_sandbox")) {
          if (openedInRun) activeController.abort(new Error("stop_before_network"));
          return { rows: [{ id: launchJobId } as T] };
        }
        if (statement.includes("as deleted")) return { rows: [{ deleted: false } as T] };
        if (statement.includes("modal_server_apps")) {
          openedInRun = true;
          return {
            rows: [
              {
                workspace: "app:ap-1",
                environment: "main",
                app_id: "ap-1",
                app_name: "armada-org",
                authority_scope: "org",
                authority_owner_id: orgId,
                id: sandboxId,
                orgId,
                ownerId,
                provider: "modal",
                harness: "codex",
                status: "starting",
                deletedAt: null,
                stopRequestedAt: null,
                expiresAt: new Date(Date.now() + 600_000),
                credentialId: crypto.randomUUID(),
                credentialVersion: 1,
                repositoryDir: null,
                jobCreatedAt: new Date(),
                visibility: "org",
                sourceVisibility: "org",
                appName: "armada-org",
                credentialScope: "org",
                credentialOwnerId: orgId,
              } as T,
            ],
          };
        }
        if (statement.includes("as check_after")) {
          return {
            rows: [
              {
                org_id: orgId,
                provider_sandbox_id: "sb-1",
                credential_id: null,
                credential_version: null,
                journaled_id: "sb-1",
                has_intent: true,
                stop_requested: false,
                starting: true,
                enrolled: false,
                check_after: null,
                cancel_without_provider: false,
                bootstrap_ticket_enc: null,
                handoff_staged: false,
                ticket_issued: false,
              } as T,
            ],
          };
        }
        return { rows: [] as T[] };
      },
      async transaction<T>(work: (tx: Sql) => Promise<T>) {
        return work(sql);
      },
    };
    let credentialAttempt = 0;
    const staleFailureStarted = Promise.withResolvers<void>();
    const staleFailureGate = Promise.withResolvers<void>();
    const modal = createModalIntegration({
      sql,
      encryptionKey,
      publicUrl: "https://armada.example",
      vault: {
        credentials: async () => {
          credentialAttempt++;
          if (credentialAttempt === 4) {
            staleFailureStarted.resolve();
            await staleFailureGate.promise;
            return [];
          }
          return [{ id: "cred-1", version: 1, kind: "modal", status: "active", valueEnc: activeTokens }];
        },
        orgBoatKey: async () => null,
      },
    });
    const warmed: ModalArtifactBinding[] = [];
    const launchJob = modal.launchJob(
      async () => {
        throw new Error("unused");
      },
      { beginWarming: (binding) => void warmed.push(binding) },
    );
    const baseJob = {
      sandbox_id: sandboxId,
      generation: "1",
      lease_epoch: "1",
      attempts: 1,
      max_attempts: 3,
      outcome: null,
    };
    const cleanupJob: Job = {
      ...baseJob,
      id: crypto.randomUUID(),
      kind: "delete",
      payload: { launchJobId, machineId: "sb-1" },
    };
    const launchWork: Job = {
      ...baseJob,
      id: launchJobId,
      kind: "launch",
      payload: {
        allocation: { source: { kind: "snapshot", ref: "im-1" }, size: "small", computeTtlSeconds: 600 },
        snapshot: "snap-1",
        modal: { workspace: "app:ap-1", environment: "main", appId: "ap-1" },
      },
    };
    const runWithAbort = async (work: (context: JobContext) => Promise<unknown>) => {
      activeController = new AbortController();
      openedInRun = false;
      await expect(
        work({ signal: activeController.signal, canDispatch: async () => true, handoffGeneration: async () => "1" }),
      ).rejects.toThrow("stop_before_network");
    };

    await runWithAbort((context) => modal.launchCleanupJob.run(cleanupJob, context));
    await runWithAbort((context) => modal.launchCleanupJob.run(cleanupJob, context));
    expect(closeSpy).toHaveBeenCalledTimes(0);

    await runWithAbort((context) => launchJob.run(launchWork, context));
    expect(warmed).toEqual([
      { appId: "ap-1", appName: "armada-org", environment: "main", tokenId: "ak-fixture1", tokenSecret: "as-fixture1" },
    ]);
    expect(closeSpy).toHaveBeenCalledTimes(0);

    activeTokens = await encodeTokens("fixture2");
    const staleMissingRun = modal.launchCleanupJob.run(cleanupJob, {
      signal: new AbortController().signal,
      canDispatch: async () => true,
      handoffGeneration: async () => "1",
    });
    await staleFailureStarted.promise;
    await runWithAbort((context) => modal.launchCleanupJob.run(cleanupJob, context));
    expect(closeSpy).toHaveBeenCalledTimes(1);

    staleFailureGate.resolve();
    await expect(staleMissingRun).rejects.toThrow("Modal");
    expect(closeSpy).toHaveBeenCalledTimes(1);

    await launchJob.drain?.();
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(fromNameSpy).not.toHaveBeenCalled();
  } finally {
    fromNameSpy.mockRestore();
    closeSpy.mockRestore();
  }
});
