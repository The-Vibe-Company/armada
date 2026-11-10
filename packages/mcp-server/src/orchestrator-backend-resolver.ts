import {
  createSqlGoldenStore,
  createSqlSandboxStore,
  GOLDEN_ROOT,
  type GoldenActor,
  type GoldenRecord,
  type Harness,
  type HarnessCredentials,
  type LaunchCredentialResolver,
  type LaunchStores,
  mapSandboxRow,
  type OrchestratorCreate,
  type Provider,
  type ProviderRegistry,
  type ProviderTarget,
  resolveModelChoice,
  resolveRepositoryDir,
  type SandboxRow,
  type Sql,
} from "@armada/core/server";
import { createBoatOrchestratorProvider } from "./boat-orchestrator-provider.ts";
import { launchOrchestratorParent } from "./orchestrator-launch.ts";
import type { ManagedMachine, ManagedNativeBackend, ManagedSelection } from "./orchestrator-managed-runtime.ts";
import type { OrchestratorRuntimeBackend, OrchestratorRuntimeOptions } from "./orchestrator-runtime.ts";
import { OrchestratorRuntimeError, type RuntimeIdentity } from "./orchestrator-runtime-store.ts";

/** A concrete adapter is mandatory; Boat declares best-effort explicitly. Missing
 * entries never fall back to another harness/provider or a capability bit. */
export interface OrchestratorNativeAdapter {
  readonly continuity?: "best_effort";
  assertPrerequisites(provider: Provider, golden: GoldenRecord, configuration: OrchestratorCreate): Promise<void>;
  resumeWithoutText?(
    provider: Provider,
    identity: RuntimeIdentity,
    operationId: string,
  ): Promise<void | {
    conversationContinued: boolean;
    reason?: "conversation_metadata_missing" | "conversation_harness_mismatch";
  }>;
  managed(provider: Provider, machine: ManagedMachine, selection: ManagedSelection): ManagedNativeBackend;
}
export interface NamedOrchestratorCredentials extends LaunchCredentialResolver {
  resolve(
    actor: GoldenActor,
    harness: Harness,
    credentialId?: string,
    credentialVersion?: number,
  ): Promise<HarnessCredentials>;
}

/** Actual v2 provider registry + SQL golden identity + #603 named resolver. The supplied
 * credentials object MUST be the #604 lifecycle-aware instance used by ordinary launch;
 * parent launch preserves it rather than inventing another redaction/ownership registry. */
export function createOrchestratorBackendResolver(input: {
  sql: Sql;
  providers: ProviderRegistry;
  credentials: NamedOrchestratorCredentials;
  connections?: LaunchStores["connections"];
  mcpUrl: string;
  encryptionKey?: string;
  native(provider: Provider["id"], harness: Harness): OrchestratorNativeAdapter | undefined;
  consent(actor: GoldenActor, configuration: OrchestratorCreate): Promise<OrchestratorRuntimeBackend["consent"]>;
}) {
  const goldens = createSqlGoldenStore(input.sql);
  async function member(configuration: OrchestratorCreate, ownerId: string): Promise<GoldenActor> {
    const row = (
      await input.sql.query<{ role: "admin" | "member" }>(
        `select role from public.members where org_id=$1 and user_id=$2`,
        [configuration.orgId, ownerId],
      )
    ).rows[0];
    if (!row) throw new OrchestratorRuntimeError("not_found");
    return { orgId: configuration.orgId, userId: ownerId, role: row.role };
  }
  async function selectedGolden(configuration: OrchestratorCreate, actor: GoldenActor): Promise<GoldenRecord> {
    const golden = (await goldens.list(actor.orgId)).find((row) => row.id === configuration.goldenId);
    if (!golden || golden.orgId !== actor.orgId || (golden.visibility === "private" && golden.ownerId !== actor.userId))
      throw new OrchestratorRuntimeError("not_found");
    if (golden.provider !== configuration.provider || !golden.providerSnapshotId)
      throw new OrchestratorRuntimeError("conflict");
    return golden;
  }
  async function named(actor: GoldenActor, configuration: OrchestratorCreate, version?: number) {
    const credentials = await input.credentials.resolve(
      actor,
      configuration.harness,
      configuration.modelAccountId,
      version,
    );
    const value: unknown = Reflect.get(credentials, "binding");
    if (
      !value ||
      typeof value !== "object" ||
      !("credentialId" in value) ||
      !("credentialVersion" in value) ||
      value.credentialId !== configuration.modelAccountId ||
      !Number.isSafeInteger(value.credentialVersion) ||
      Number(value.credentialVersion) < 1 ||
      (version !== undefined && value.credentialVersion !== version)
    )
      throw new OrchestratorRuntimeError("unavailable");
    return { credentials, version: Number(value.credentialVersion) };
  }
  const resolveBackend: OrchestratorRuntimeOptions["resolveBackend"] = async (configuration, ownerId, identity) => {
    const actor = await member(configuration, ownerId);
    const golden = await selectedGolden(configuration, actor);
    const adapter = input.native(configuration.provider, configuration.harness);
    if (!adapter) throw new OrchestratorRuntimeError("unavailable");
    let pinnedVersion: number | undefined;
    let repositoryDir: string | null = null;
    let choice = resolveModelChoice(configuration.harness, configuration);
    if (identity?.sandboxId) {
      const binding = (
        await input.sql.query<{
          credential_id: string | null;
          credential_version: number | null;
          repository_dir: string | null;
          model: string | null;
          reasoning_effort: string | null;
        }>(
          `select credential_id,credential_version,repository_dir,model,reasoning_effort from public.sandboxes
        where id=$1 and org_id=$2 and owner_id=$3 and golden_id=$4 and provider=$5 and harness=$6 and visibility='private'`,
          [
            identity.sandboxId,
            actor.orgId,
            ownerId,
            configuration.goldenId,
            configuration.provider,
            configuration.harness,
          ],
        )
      ).rows[0];
      if (
        !binding ||
        binding.credential_id !== configuration.modelAccountId ||
        !Number.isSafeInteger(binding.credential_version) ||
        Number(binding.credential_version) < 1 ||
        binding.model !== configuration.model
      )
        throw new OrchestratorRuntimeError("conflict");
      pinnedVersion = Number(binding.credential_version);
      repositoryDir = binding.repository_dir;
      if (repositoryDir !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(repositoryDir))
        throw new OrchestratorRuntimeError("conflict");
      choice = resolveModelChoice(configuration.harness, {
        model: binding.model,
        ...(binding.reasoning_effort ? { reasoningEffort: binding.reasoning_effort } : {}),
      });
    }
    if (!identity?.sandboxId) repositoryDir = resolveRepositoryDir(golden, configuration.repo);
    const selected = await named(actor, configuration, pinnedVersion);
    const target: ProviderTarget = identity?.sandboxId
      ? await persistedTarget(identity.sandboxId, ownerId, configuration.orgId)
      : golden;
    const rawProvider = await input.providers.resolve(target, { userId: ownerId });
    const provider =
      configuration.provider === "boat"
        ? createBoatOrchestratorProvider(rawProvider, input.encryptionKey)
        : rawProvider;
    if (provider.id !== configuration.provider) throw new OrchestratorRuntimeError("conflict");
    const scopedGoldens = new Proxy(goldens, {
      get(target, key) {
        if (key === "findByName")
          return async (orgId: string, name: string) =>
            (await target.findByName(orgId, name)).filter((row) => row.id === configuration.goldenId);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const resume = adapter.resumeWithoutText?.bind(adapter);
    const backend: OrchestratorRuntimeBackend = {
      provider,
      ...(adapter.continuity ? { continuity: adapter.continuity } : {}),
      selection: choice,
      projectDir: repositoryDir === null ? GOLDEN_ROOT : `${GOLDEN_ROOT}/${repositoryDir}`,
      mcpUrl: input.mcpUrl,
      consent: await input.consent(actor, configuration),
      assertNativeProof: () => adapter.assertPrerequisites(provider, golden, configuration),
      revalidate: async (current) => {
        const fresh = await member(configuration, ownerId);
        await selectedGolden(configuration, fresh);
        await named(fresh, configuration, selected.version);
        if (current.sandboxId) {
          const assertTurn = Reflect.get(input.credentials, "assertTurn");
          if (typeof assertTurn === "function")
            await Reflect.apply(assertTurn, input.credentials, [
              fresh,
              current.sandboxId,
              current.state === "stopped" || current.state === "resuming",
            ]);
        }
      },
      prepareMcp: async (current) => {
        if (
          !input.connections?.prepare ||
          !current.sandboxId ||
          !current.providerSandboxId ||
          current.generation === null
        )
          return;
        const fresh = await member(configuration, ownerId);
        const row = (
          await input.sql.query<SandboxRow>(
            `select s.* from public.sandboxes s where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and s.provider_sandbox_id=$4 and s.lifecycle_generation=$5`,
            [current.sandboxId, ownerId, configuration.orgId, current.providerSandboxId, current.generation],
          )
        ).rows[0];
        if (!row) throw new OrchestratorRuntimeError("conflict");
        await input.connections.prepare(provider, mapSandboxRow(row), fresh);
      },
      launch: (reservation, diagnostics, hooks) =>
        launchOrchestratorParent({
          sql: input.sql,
          provider,
          actor,
          request: {
            golden: golden.name,
            provider: configuration.provider,
            harness: configuration.harness,
            model: configuration.model,
            ...(configuration.connections === undefined ? {} : { connections: configuration.connections }),
            ...(configuration.reasoningEffort === undefined ? {} : { reasoningEffort: configuration.reasoningEffort }),
            ...(configuration.repo === undefined ? {} : { repo: configuration.repo }),
            ...(configuration.size === undefined ? {} : { size: configuration.size }),
          },
          stores: {
            goldens: scopedGoldens,
            sandboxes: createSqlSandboxStore(input.sql),
            credentials: input.credentials,
            ...(input.connections ? { connections: input.connections } : {}),
          },
          reservation,
          ...(diagnostics ? { diagnostics } : {}),
          ...(hooks ? { hooks } : {}),
          account: {
            credentialId: configuration.modelAccountId,
            credentialVersion: selected.version,
            resolve: (a, h, id, version) => input.credentials.resolve(a, h, id, version),
          },
        }),
      ...(resume
        ? {
            resumeWithoutText: (current: RuntimeIdentity, operationId: string) =>
              resume(provider, current, operationId),
          }
        : {}),
    };
    return backend;
  };
  async function persistedTarget(sandboxId: string, ownerId: string, orgId: string): Promise<ProviderTarget> {
    const row = (
      await input.sql.query<{
        provider: ProviderTarget["provider"];
        visibility: ProviderTarget["visibility"];
        source_golden_visibility: ProviderTarget["visibility"];
        modal_workspace: string | null;
        modal_environment: string | null;
        modal_app_id: string | null;
      }>(
        `select s.provider,s.visibility,s.source_golden_visibility,g.modal_workspace,g.modal_environment,g.modal_app_id
       from public.sandboxes s join public.goldens g on g.id=s.golden_id where s.id=$1 and s.owner_id=$2 and s.org_id=$3`,
        [sandboxId, ownerId, orgId],
      )
    ).rows[0];
    if (!row) throw new OrchestratorRuntimeError("not_found");
    const modal =
      row.provider === "modal" && row.modal_workspace && row.modal_environment && row.modal_app_id
        ? { workspace: row.modal_workspace, environment: row.modal_environment, appId: row.modal_app_id }
        : null;
    if (row.provider === "modal" && !modal) throw new OrchestratorRuntimeError("unavailable");
    return {
      provider: row.provider,
      orgId,
      visibility: row.visibility,
      sourceGoldenVisibility: row.source_golden_visibility,
      modal,
    };
  }
  const resolveManaged: NonNullable<OrchestratorRuntimeOptions["managed"]>["resolveManaged"] = async (
    machine,
    selection,
  ) => {
    // Deliberately NO member/model-credential resolution on trusted removed-owner cleanup.
    const row = (
      await input.sql.query<{ harness: Harness }>(
        `select s.harness from public.sandboxes s join public.orchestrators o on o.sandbox_id=s.id
      where o.id=$1 and s.id=$2 and s.provider_sandbox_id=$3 and s.lifecycle_generation=$4 and o.owner_id=$5 and o.org_id=$6`,
        [
          machine.orchestratorId,
          machine.sandboxId,
          machine.providerSandboxId,
          machine.generation,
          selection.ownerId,
          selection.orgId,
        ],
      )
    ).rows[0];
    if (!row) throw new OrchestratorRuntimeError("conflict");
    const adapter = input.native(selection.provider, row.harness);
    if (!adapter) throw new OrchestratorRuntimeError("unavailable");
    const target = await persistedTarget(machine.sandboxId, selection.ownerId, selection.orgId);
    if (target.provider !== selection.provider) throw new OrchestratorRuntimeError("conflict");
    const rawProvider = await input.providers.resolve(target, {
      userId: selection.ownerId,
      orchestratorCleanup: { ...machine, ...(selection.operationId ? { operationId: selection.operationId } : {}) },
    });
    const provider =
      selection.provider === "boat" ? createBoatOrchestratorProvider(rawProvider, input.encryptionKey) : rawProvider;
    const backend = adapter.managed(provider, machine, selection);
    const inspect = provider.observeOrchestrator?.bind(provider);
    if (!inspect || provider.id !== "modal") return backend; // A different native adapter must supply real observation, never a capability bit.
    return new Proxy(backend, {
      get(target, key) {
        if (key === "observe")
          return async (current: ManagedMachine, signal?: AbortSignal) => {
            signal?.throwIfAborted();
            const native = await provider.get(current.providerSandboxId, { ...(signal ? { signal } : {}) });
            if (!native.physicalGeneration || !["ready", "running"].includes(native.state))
              return {
                ...current,
                physicalGeneration: native.physicalGeneration ?? null,
                state: "unknown" as const,
                evidence: "native:unavailable",
              };
            const observed = await inspect({
              sandboxId: current.providerSandboxId,
              physicalGeneration: native.physicalGeneration,
            });
            return {
              ...current,
              physicalGeneration: native.physicalGeneration,
              state: observed.state,
              evidence: `native:${observed.evidence}`,
            };
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return { resolveBackend, resolveManaged };
}
