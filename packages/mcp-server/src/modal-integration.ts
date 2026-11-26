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
import type { JobKind } from "./jobs/runner.ts";
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
  ): Promise<ModalManagementAuthority> {
    if (!target.modal) throw new VaultError("invalid", "Modal binding is missing.");
    const result = await options.sql.query<{ authority_scope: "org" | "user"; authority_owner_id: string }>(
      "select authority_scope,authority_owner_id from public.modal_server_apps where org_id=$1 and app_id=$2 and environment=$3",
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
    const authority = await options.sql.query<{ app_name: string }>(
      "select app_name from public.modal_server_apps where org_id=$1 and app_id=$2 and environment=$3",
      [context.target.orgId, binding.appId, binding.environment],
    );
    const appName = authority.rows[0]?.app_name;
    if (!appName) throw new Error("Modal App binding is not registered on this server.");
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
    const provenance = await managementAuthority(context.target, context.caller);
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
  };
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
  const machineClients = new Map<string, ModalClient>();
  const machineCallSignal = new AsyncLocalStorage<AbortSignal>();
  const closeMachineClients = () => {
    for (const client of machineClients.values()) client.close();
    machineClients.clear();
  };
  const openMachine = async (
    { appName, binding, ...authority }: Parameters<Parameters<typeof createModalLaunchCleanupJob>[1]>[0],
    signal: AbortSignal,
    onRuntimeBinding?: (binding: ModalArtifactBinding) => void,
  ) => {
    const slot = `${authority.credentialScope}:${authority.credentialOwnerId}`;
    const observed = machineClients.get(slot);
    const { tokenId, tokenSecret, id, version } = await resolveManagementCredentials(authority).catch(
      (error: unknown) => {
        if (
          error instanceof VaultError &&
          (error.code === "missing_credential" || error.code === "unavailable") &&
          observed &&
          machineClients.get(slot) === observed
        ) {
          machineClients.delete(slot);
          observed.close();
        }
        throw error;
      },
    );
    if (!id || !version) throw new Error("Modal platform credential revision is unavailable.");
    signal.throwIfAborted();
    let client = machineClients.get(slot);
    if (client?.profile.tokenId !== tokenId || client?.profile.tokenSecret !== tokenSecret) {
      client?.close();
      client = new ModalClient({
        tokenId,
        tokenSecret,
        maxThrottleWaitSecs: 0,
        grpcMiddleware: [
          async function* (call, rpc) {
            const active = machineCallSignal.getStore();
            const signals = [rpc.signal, active].filter((entry): entry is AbortSignal => entry !== undefined);
            const requestSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
            requestSignal?.throwIfAborted();
            const boundedRpc = { ...rpc, ...(requestSignal ? { signal: requestSignal } : {}), retries: 0 };
            return yield* call.next(call.request, boundedRpc);
          },
        ],
      });
      machineClients.set(slot, client);
    }
    onRuntimeBinding?.({ appId: binding.appId, appName, environment: binding.environment, tokenId, tokenSecret });
    const deploymentId = modalDeploymentId(binding.environment, options.publicUrl);
    return {
      client,
      appName,
      binding,
      deploymentId,
      async modalCredential() {
        return { id, version };
      },
      close: () => {},
      resolveRuntimeTicket: async () => null,
    };
  };
  const wrapMachineJob = (handler: JobKind) => {
    const wrapped: JobKind = {
      ...handler,
      run: (job, context) => machineCallSignal.run(context.signal, () => handler.run(job, context)),
      async drain() {
        await handler.drain?.();
        closeMachineClients();
      },
    };
    return wrapped;
  };
  async function launchProviderFor(target: ProviderTarget, caller: { userId: string }) {
    if (target.provider !== "modal" || !target.modal) throw new VaultError("invalid", "Expected Modal binding.");
    const tokens = await modalTokensFor(target, caller);
    const { provider } = await modalProviderFor(
      // The resolver's scope label is not the structured machine Scope.
      // Pass only the token pair, exactly as the live registry does.
      { tokenId: tokens.tokenId, tokenSecret: tokens.tokenSecret },
      target.modal,
      { target, caller, credentialScope: tokens.scope },
      true,
    );
    return provider;
  }
  return {
    launchCleanupJob: wrapMachineJob(createModalLaunchCleanupJob(options.sql, openMachine)),
    launchJob: (
      prepare: Parameters<typeof createModalLaunchJob>[3],
      cache?: Pick<ReturnType<typeof createModalArtifactCache>, "beginWarming">,
      logError?: (line: string) => void,
    ) =>
      wrapMachineJob(
        createModalLaunchJob(
          options.sql,
          options.encryptionKey,
          (request, signal) =>
            openMachine(
              request,
              signal,
              cache ? (binding) => cache.beginWarming(binding, logError ?? console.error) : undefined,
            ),
          prepare,
        ),
      ),
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
