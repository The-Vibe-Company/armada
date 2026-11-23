import { AsyncLocalStorage } from "node:async_hooks";
import { HOST_CAPABILITIES } from "@armada/core";
import {
  type CredentialReader,
  createSqlVaultStore,
  decryptSecret,
  type ModalBinding,
  type ProviderTarget,
  parseModalTokenPair,
  resolveModalTokens,
  type Sql,
  VaultError,
} from "@armada/core/server";
import {
  createModalMachineInventory,
  createRuntimeModalProvider,
  MODAL_IMAGE_LOCK,
  type ModalManagementAuthority,
  modalDeploymentId,
  type ResolvedModalManagementCredentials,
  type RuntimeModalOptions,
  type Scope,
  scopeKey,
} from "@armada/provider-modal";
import { ModalClient } from "modal";
import type { HandlerOptions } from "./http.ts";
import { createModalLaunchCleanupJob, createModalLaunchJob } from "./jobs/modal-launch.ts";
import {
  type createModalArtifactCache,
  type ModalArtifactBinding,
  modalArtifactFailure,
} from "./modal-artifact-cache.ts";
import { boundedModalSql, createModalReaper } from "./modal-reaper.ts";
import { diagnosticSandboxId } from "./provider-sandbox-target.ts";
import { observeProvider, observeProviderCall } from "./request-observability.ts";
import { measureProviderPhase } from "./request-timing.ts";
import { createRuntimeServing } from "./runtime-serving.ts";

export type { ModalManagementAuthority } from "@armada/provider-modal";

export function createModalIntegration(options: {
  sql: Sql;
  vault: CredentialReader;
  encryptionKey: string;
  publicUrl: string;
}) {
  async function managementAuthority(
    target: ProviderTarget,
    caller: { userId: string },
  ): Promise<ModalManagementAuthority & { appName: string }> {
    if (!target.modal) throw new VaultError("invalid", "Modal binding is missing.");
    const result = await options.sql.query<{
      authority_scope: "org" | "user";
      authority_owner_id: string;
      app_name: string;
    }>(
      "select authority_scope,authority_owner_id,app_name from public.modal_server_apps where org_id=$1 and app_id=$2 and environment=$3",
      [target.orgId, target.modal.appId, target.modal.environment],
    );
    const saved = result.rows[0];
    if (!saved) throw new VaultError("unavailable", "Modal credential provenance is not registered.");
    const sourceVisibility = target.sourceGoldenVisibility ?? target.visibility;
    if (
      saved.authority_scope === "org"
        ? saved.authority_owner_id !== target.orgId
        : saved.authority_owner_id !== caller.userId || sourceVisibility !== "private"
    )
      throw new VaultError("forbidden", "Modal credential authority does not match this resource.");
    return {
      orgId: target.orgId,
      appName: saved.app_name,
      sourceGoldenVisibility: sourceVisibility,
      credentialScope: saved.authority_scope,
      credentialOwnerId: saved.authority_owner_id,
      binding: target.modal,
    };
  }
  async function resolveManagementCredentials(
    authority: Pick<ModalManagementAuthority, "credentialScope" | "credentialOwnerId">,
    vault: CredentialReader = options.vault,
  ): Promise<ResolvedModalManagementCredentials & { id: string | undefined; version: number | undefined }> {
    const row = (await vault.credentials(authority.credentialScope, authority.credentialOwnerId)).find(
      (candidate) => candidate.kind === "modal" && candidate.status === "active",
    );
    if (!row)
      throw new VaultError(
        "missing_credential",
        "The Modal credential bound to this resource was removed. Restore that credential slot.",
      );
    const value = await decryptSecret(new Uint8Array(row.valueEnc), options.encryptionKey);
    try {
      return {
        ...parseModalTokenPair(value),
        credentialScope: authority.credentialScope,
        credentialOwnerId: authority.credentialOwnerId,
        id: row.id,
        version: row.version,
      };
    } catch {
      throw new VaultError("unavailable", "The bound Modal credential is invalid. Replace that credential slot.");
    }
  }
  async function warmRegisteredArtifactCaches(
    cache: ReturnType<typeof createModalArtifactCache>,
    stop: AbortSignal,
    logError: (line: string) => void,
  ) {
    const startupBudget = AbortSignal.any([stop, AbortSignal.timeout(120_000)]);
    const startupSql = boundedModalSql(options.sql);
    const vault = createSqlVaultStore(startupSql);
    const { rows } = await startupSql.query<{
      app_id: string;
      app_name: string;
      environment: string;
      authority_scope: "org" | "user";
      authority_owner_id: string;
    }>(
      "select distinct app_id, app_name, environment, authority_scope, authority_owner_id from public.modal_server_apps",
    );
    const reportFailure = (cause: string) => {
      if (stop.aborted) return;
      logError(
        `Modal startup artifact warming failed for a registered App: ${startupBudget.aborted ? "startup warming deadline exceeded" : cause}. Retrying on enrolled allocation.`,
      );
    };
    for (let offset = 0; offset < rows.length && !startupBudget.aborted; offset += 4) {
      const seeds: Promise<void>[] = [];
      for (const row of rows.slice(offset, offset + 4)) {
        if (startupBudget.aborted) break;
        try {
          const { tokenId, tokenSecret } = await resolveManagementCredentials(
            { credentialScope: row.authority_scope, credentialOwnerId: row.authority_owner_id },
            vault,
          );
          startupBudget.throwIfAborted();
          seeds.push(
            cache
              .warm(
                { appId: row.app_id, appName: row.app_name, environment: row.environment, tokenId, tokenSecret },
                startupBudget,
              )
              .catch((error) => reportFailure(modalArtifactFailure(error))),
          );
        } catch (error) {
          reportFailure(
            error instanceof VaultError && error.code === "missing_credential"
              ? "registered Modal credential is missing"
              : "could not resolve the registered Modal credential",
          );
        }
      }
      await Promise.all(seeds);
    }
  }
  const modalTokensFor: NonNullable<HandlerOptions["modalTokensFor"]> = async (target, caller) => {
    const authority = await managementAuthority(target, caller);
    const pair = await resolveManagementCredentials(authority);
    return { tokenId: pair.tokenId, tokenSecret: pair.tokenSecret, scope: authority.credentialScope };
  };
  const modalProviderFor = async (
    tokens: Parameters<NonNullable<HandlerOptions["modalProviderFor"]>>[0],
    binding: Parameters<NonNullable<HandlerOptions["modalProviderFor"]>>[1],
    context: Parameters<NonNullable<HandlerOptions["modalProviderFor"]>>[2],
    storedReads = false,
    onRuntimeBinding?: (binding: ModalArtifactBinding) => void,
  ) => {
    const provenance = await managementAuthority(context.target, context.caller);
    return providerWithAuthority(tokens, binding, context, provenance, storedReads, onRuntimeBinding);
  };
  async function providerWithAuthority(
    tokens: Parameters<NonNullable<HandlerOptions["modalProviderFor"]>>[0],
    binding: ModalBinding,
    context: Parameters<NonNullable<HandlerOptions["modalProviderFor"]>>[2],
    provenance: Awaited<ReturnType<typeof managementAuthority>>,
    storedReads: boolean,
    onRuntimeBinding?: (binding: ModalArtifactBinding) => void,
  ) {
    const { appName } = provenance;
    const scope: Scope = {
      orgId: context.target.orgId,
      userId: context.caller.userId,
      visibility: context.target.visibility,
      binding,
    };
    if (!storedReads)
      await options.sql.query(
        "insert into public.modal_server_scopes(scope,context) values($1,$2::jsonb) on conflict(scope) do nothing",
        [scopeKey(scope), JSON.stringify(scope)],
      );
    const sourceScope: Scope = { ...scope, visibility: provenance.sourceGoldenVisibility };
    const composed: RuntimeModalOptions = {
      measure: measureProviderPhase,
      storedReads,
      sql: options.sql,
      scope,
      sourceScope,
      managementAuthority: {
        credentialScope: provenance.credentialScope,
        credentialOwnerId: provenance.credentialOwnerId,
      },
      resolveManagementCredentials,
      ...tokens,
      appName,
      publicUrl: options.publicUrl,
      image: MODAL_IMAGE_LOCK,
    };
    // Stored reads skip the App lookup and every live Modal call: they read Armada's database, so no provider record.
    if (storedReads) return createRuntimeModalProvider(composed);
    const sandbox = { sandboxId: () => diagnosticSandboxId(context.target) };
    const { provider, captureRuntimeWork } = await observeProviderCall(
      "modal",
      "initialize",
      () => createRuntimeModalProvider(composed),
      undefined,
      sandbox,
    );
    onRuntimeBinding?.({ appId: binding.appId, appName, environment: binding.environment, ...tokens });
    return {
      provider: observeProvider("modal", provider, sandbox),
      captureRuntimeWork: observeProvider("modal", { captureRuntimeWork }, sandbox).captureRuntimeWork,
    };
  }
  async function goldenTarget(
    target: Omit<ProviderTarget, "modal">,
    caller: { userId: string },
  ): Promise<ProviderTarget> {
    if (!HOST_CAPABILITIES[target.provider].requiresPinnedGoldenBinding) return { ...target, modal: null };
    const resolved = await resolveModalTokens(options.vault, options.encryptionKey, {
      ...caller,
      orgId: target.orgId,
      visibility: target.visibility,
    });
    const owner = resolved.scope === "org" ? target.orgId : caller.userId;
    const appName = `armada-${resolved.scope}-${owner.replaceAll("-", "")}`;
    const environment = "main";
    const client = new ModalClient({ tokenId: resolved.tokenId, tokenSecret: resolved.tokenSecret });
    try {
      const app = await observeProviderCall("modal", "app.fromName", () =>
        client.apps.fromName(appName, { environment, createIfMissing: true }),
      );
      const modal: ModalBinding = { workspace: `app:${app.appId}`, environment, appId: app.appId };
      await options.sql.query(
        "insert into public.modal_server_apps(org_id,authority,app_name,app_id,environment,authority_scope,authority_owner_id) values($1,$2,$3,$4,$5,$6,$7) on conflict(org_id,authority,environment) do nothing",
        [target.orgId, `${resolved.scope}:${owner}`, appName, app.appId, environment, resolved.scope, owner],
      );
      const stored = await options.sql.query<{ app_id: string }>(
        "select app_id from public.modal_server_apps where org_id=$1 and authority=$2 and environment=$3",
        [target.orgId, `${resolved.scope}:${owner}`, environment],
      );
      if (stored.rows[0]?.app_id !== app.appId)
        throw new Error("Modal credentials cannot replace the immutable App binding.");
      return { ...target, modal };
    } finally {
      await client.close();
    }
  }
  function inventoryReaper(log?: (line: string) => void) {
    const sql = boundedModalSql(options.sql);
    const vault = createSqlVaultStore(sql);
    const clients = new Map<string, ModalClient>();
    const terminationDeadline = new AsyncLocalStorage<AbortSignal>();
    const lane = createModalReaper(
      sql,
      options.publicUrl,
      async (registration, binding, deploymentId, shutdown) => {
        const authority = {
          credentialScope: registration.authority_scope,
          credentialOwnerId: registration.authority_owner_id,
        };
        const slot = `${authority.credentialScope}:${authority.credentialOwnerId}`;
        let client = clients.get(slot);
        const { tokenId, tokenSecret } = await resolveManagementCredentials(authority, vault).catch(
          (error: unknown) => {
            if (error instanceof VaultError && (error.code === "missing_credential" || error.code === "unavailable")) {
              client?.close();
              clients.delete(slot);
            }
            throw error;
          },
        );
        shutdown.throwIfAborted();
        if (client?.profile.tokenId !== tokenId || client?.profile.tokenSecret !== tokenSecret) {
          client?.close();
          client = new ModalClient({
            tokenId,
            tokenSecret,
            maxThrottleWaitSecs: 0,
            grpcMiddleware: [
              async function* (call, options) {
                const deadline = AbortSignal.timeout(10_000);
                const signal = AbortSignal.any([
                  shutdown,
                  deadline,
                  ...[options.signal, terminationDeadline.getStore()].filter(
                    (signal): signal is AbortSignal => signal !== undefined,
                  ),
                ]);
                signal.throwIfAborted();
                return yield* call.next(call.request, { ...options, signal });
              },
            ],
          });
          clients.set(slot, client);
        }
        const inventoryClient = client;
        return {
          ...createModalMachineInventory(inventoryClient, registration.app_name, binding, deploymentId),
          async openSandbox(machineId) {
            const sandbox = await inventoryClient.sandboxes.fromId(machineId);
            return {
              terminate: () => sandbox.terminate(),
              waitForTermination: (signal) =>
                terminationDeadline.run(AbortSignal.any([signal, AbortSignal.timeout(10_000)]), () => sandbox.wait()),
            };
          },
        };
      },
      {
        log,
        onRegistrations(registrations) {
          const active = new Set(registrations.map((row) => `${row.authority_scope}:${row.authority_owner_id}`));
          for (const [slot, client] of clients) {
            if (active.has(slot)) continue;
            client.close();
            clients.delete(slot);
          }
        },
      },
    );
    return {
      ...lane,
      async drain() {
        await lane.drain();
        for (const client of clients.values()) client.close();
        clients.clear();
      },
    };
  }
  const openMachine = async (
    { appName, binding, ...authority }: Parameters<Parameters<typeof createModalLaunchCleanupJob>[1]>[0],
    signal: AbortSignal,
  ) => {
    const { tokenId, tokenSecret, id, version } = await resolveManagementCredentials(authority);
    if (!id || !version) throw new Error("Modal platform credential revision is unavailable.");
    signal.throwIfAborted();
    const deploymentId = modalDeploymentId(binding.environment, options.publicUrl);
    const client = new ModalClient({
      tokenId,
      tokenSecret,
      maxThrottleWaitSecs: 0,
      grpcMiddleware: [
        async function* (call, rpc) {
          const requestSignal = rpc.signal ? AbortSignal.any([rpc.signal, signal]) : signal;
          requestSignal.throwIfAborted();
          const boundedRpc = { ...rpc, signal: requestSignal, retries: 0, timeoutMs: 10_000 };
          return yield* call.next(call.request, boundedRpc);
        },
      ],
    });
    return {
      client,
      appName,
      binding,
      deploymentId,
      async canUseModalCredential(tx: Sql) {
        const { rows } = await tx.query(
          `select 1 from public.credentials where id=$1 and version=$2 and status='active'
            and kind='modal' and scope=$3 and owner_id=$4 and (expires_at is null or expires_at>clock_timestamp())
            for share`,
          [id, version, authority.credentialScope, authority.credentialOwnerId],
        );
        return rows.length > 0;
      },
      close: () => client.close(),
      resolveRuntimeTicket: async () => null,
      async prepareCheckpoint() {
        throw new Error("Modal launch and cleanup cannot prepare a checkpoint.");
      },
    };
  };
  async function launchProviderFor(target: ProviderTarget, caller: { userId: string }) {
    if (target.provider !== "modal" || !target.modal) throw new VaultError("invalid", "Expected Modal binding.");
    const authority = await managementAuthority(target, caller);
    const { tokenId, tokenSecret } = await resolveManagementCredentials(authority);
    const { provider } = await providerWithAuthority(
      { tokenId, tokenSecret },
      target.modal,
      { target, caller, credentialScope: authority.credentialScope },
      authority,
      true,
    );
    return provider;
  }
  return {
    launchCleanupJob: createModalLaunchCleanupJob(options.sql, openMachine),
    launchJob: (prepare: Parameters<typeof createModalLaunchJob>[3]) =>
      createModalLaunchJob(options.sql, options.encryptionKey, openMachine, prepare),
    inventoryReaper,
    warmRegisteredArtifactCaches,
    modalProviderFor,
    launchProviderFor,
    storedProviderFor: async (target: ProviderTarget, caller: { userId: string }) => {
      const host = await launchProviderFor(target, caller);
      const provider = await createRuntimeServing(options.sql, options.encryptionKey)(host, target, caller);
      // Do not let a stored observation adapter accidentally drive admission.
      const reads = new Set<PropertyKey>(["get", "getPrompt", "events"]);
      return new Proxy(provider, {
        get(object, property, receiver) {
          const value = Reflect.get(object, property, receiver);
          if (typeof value === "function" && !reads.has(property))
            return () => {
              throw new VaultError("forbidden", "Stored observations cannot perform live operations.");
            };
          return value;
        },
      });
    },
    modalTokensFor,
    goldenTarget,
  };
}
