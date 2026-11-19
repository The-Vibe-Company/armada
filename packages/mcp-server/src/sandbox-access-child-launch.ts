import {
  createSqlSandboxStore,
  failureDiagnostic,
  type GoldenActor,
  GoldenError,
  type Harness,
  type HarnessCredentials,
  isNonMutatingProviderRefusal,
  LaunchError,
  type LaunchOptions,
  type LaunchStores,
  launchSandbox,
  type Provider,
  ProviderError,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { recordOperatorDiagnostic } from "./request-observability.ts";
import type { ChildLaunchSelection, ChildOperation } from "./sandbox-access-children.ts";

/** Local proof that this executor never attempted allocation, or the SDK explicitly refused
 * without mutation. Never reconstructed from guest JSON or absence in provider listings. */
export class ChildLaunchNotAllocated extends Error {
  constructor(
    readonly reason: "preallocation_rejected" | "provider_refused",
    readonly guard = "admission",
    cause?: unknown,
  ) {
    super("Child launch was not allocated.", { cause });
  }

  record(operation: ChildOperation) {
    const error = this.cause;
    const code =
      error instanceof VaultError ||
      error instanceof LaunchError ||
      error instanceof GoldenError ||
      error instanceof ProviderError
        ? error.code
        : this.reason;
    recordOperatorDiagnostic(`scoped.child_launch.${this.guard}`, failureDiagnostic(error ?? this), {
      sandboxId: operation.sandboxId,
      operationId: operation.id,
      code,
    });
  }
}

/** Exact #612 af8a9c2 resolver projection. The binding MUST be returned and match;
 * a legacy resolver or incomplete #604 private-state pipeline is not support. */
interface PinnedModelAccountResolver {
  resolve(
    actor: GoldenActor,
    harness: Harness,
    credentialId: string,
    credentialVersion: number,
  ): Promise<
    HarnessCredentials & {
      binding?: { credentialId: string; credentialVersion: number };
    }
  >;
}

/** Actual ordinary launcher integration, without altering ordinary-worker behavior.
 * Own-child reservation already exists before any fork, and relation is bound before prompt.
 * Provider idempotency/correlation comes from that durable reservation, never a new UUID. */
export async function launchSandboxChild(input: {
  extensionHeadroomSeconds?: number;
  sql: Sql;
  provider: Provider;
  runtime?: NonNullable<LaunchOptions["runtime"]>;
  stores: LaunchStores;
  namedCredentials: PinnedModelAccountResolver;
  operation: ChildOperation;
  selection: ChildLaunchSelection;
}): Promise<{ providerSandboxId: string }> {
  const { sql, provider, operation: op, selection, runtime } = input;
  let guard = "reservation";
  let allocationAttempted = false;
  let providerRefused = false;
  try {
    if (!sql.transaction || op.action !== "launch") throw new Error("Child launch reservation unavailable.");
    const assertCurrent = async () => {
      const row = (
        await sql.query(
          `select c.id from public.orchestrator_child_operations c
      join public.armada_access_parents o on o.id=c.orchestrator_id
      join public.sandboxes s on s.id=o.sandbox_id
      join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
      where c.id=$1 and c.target_id=$2 and c.owner_id=$3 and c.org_id=$4 and c.action='launch'
      and c.orchestrator_id=$5 and c.parent_generation=$6 and c.parent_epoch=$7
      and c.state='pending' and c.dispatched_at is not null and o.state='ready'
      and (case when o.kind='sandbox' then o.generation else s.lifecycle_generation end)=c.parent_generation and o.authority_epoch=c.parent_epoch`,
          [op.id, op.sandboxId, op.ownerId, op.orgId, op.orchestratorId, op.parentGeneration, op.parentEpoch],
        )
      ).rows[0];
      if (!row) throw new Error("Child launch admission is no longer current.");
    };
    // Actual #612/202 binding columns must exist BEFORE any billable allocation.
    guard = "account_schema";
    await sql.query(`select credential_id,credential_version from public.sandboxes limit 0`);
    guard = "parent_authority";
    await assertCurrent();
    guard = "golden";
    const actor: GoldenActor = { userId: op.ownerId, orgId: op.orgId, role: "member" };
    const golden = (await input.stores.goldens.list(op.orgId)).find((g) => g.id === selection.goldenId);
    if (!golden || golden.orgId !== op.orgId || provider.id !== golden.provider)
      throw new Error("Child golden unavailable.");
    guard = "named_account";
    const credentials = await input.namedCredentials.resolve(
      actor,
      selection.harness,
      selection.credentialId,
      selection.credentialVersion,
    );
    if (
      credentials.binding?.credentialId !== selection.credentialId ||
      credentials.binding.credentialVersion !== selection.credentialVersion
    )
      throw new Error("Child named account binding unavailable; no legacy fallback.");
    let physicalId: string | undefined;
    const routed = new Proxy(provider, {
      get(target, key) {
        if (key === "fork")
          return async (request: Parameters<Provider["fork"]>[0]) => {
            guard = "parent_authority";
            await assertCurrent();
            guard = "provider_fork";
            allocationAttempted = true;
            const result = await target
              .fork({
                ...request,
                idempotencyKey: op.id,
                labels: { ...request.labels, orchestrator: op.orchestratorId, operation: op.id },
              })
              .catch((error) => {
                providerRefused = isNonMutatingProviderRefusal(error);
                throw error;
              });
            physicalId = result.id;
            await sql.query(`update public.orchestrator_child_operations set provider_sandbox_id=$2 where id=$1`, [
              op.id,
              result.id,
            ]);
            return result;
          };
        if (["exec", "prompt", "prepareNativeHarnessCwd", "configureMcp", "startRuntime"].includes(String(key))) {
          const method = Reflect.get(target, key);
          if (typeof method !== "function") return method;
          return async (...args: unknown[]) => {
            await assertCurrent();
            return method.apply(target, args);
          };
        }
        if (key === "delete" || key === "stop")
          return async (request: { sandboxId: string }) => {
            if (request.sandboxId !== physicalId) throw new Error("Child cleanup identity mismatch.");
            return key === "delete" ? target.delete(request) : target.stop(request);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const sandboxes: LaunchStores["sandboxes"] = {
      ...input.stores.sandboxes,
      async insert(record) {
        if (
          !sql.transaction ||
          record.id !== op.sandboxId ||
          record.ownerId !== op.ownerId ||
          record.orgId !== op.orgId ||
          record.providerSandboxId !== physicalId
        )
          throw new Error("Child registration identity mismatch.");
        return sql.transaction(async (tx) => {
          const saved = await createSqlSandboxStore(tx, { turnModels: true }).insert({
            ...record,
            credentialId: selection.credentialId,
            credentialVersion: selection.credentialVersion,
          });
          const binding = (
            await tx.query<{ credential_id: string | null; credential_version: number | null }>(
              `select credential_id,credential_version from public.sandboxes where id=$1`,
              [saved.id],
            )
          ).rows[0];
          if (
            binding?.credential_id !== selection.credentialId ||
            binding.credential_version !== selection.credentialVersion
          )
            throw new Error("Child named account binding was not persisted.");
          await tx.query(
            `insert into public.orchestrator_children(sandbox_id,orchestrator_id,org_id,owner_id) values($1,$2,$3,$4)`,
            [saved.id, op.orchestratorId, op.orgId, op.ownerId],
          );
          return saved;
        });
      },
    };
    // Preserve the actual credential lifecycle (including prototype hooks). Only
    // selection is pinned here; dropping admit/hydrate/release would bypass native
    // rotating-account ownership and could fork a second writer on the parent account.
    const lifecycleCredentials = new Proxy(input.stores.credentials, {
      get(target, key) {
        if (key === "resolve")
          return async (requestActor: GoldenActor, harness: Harness) => {
            if (requestActor.userId !== op.ownerId || requestActor.orgId !== op.orgId || harness !== selection.harness)
              throw new Error("Child credential scope changed.");
            return credentials;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    guard = "launch_admission";
    const launched = await launchSandbox(
      routed,
      {
        ...input.stores,
        sandboxes,
        credentials: lifecycleCredentials,
      },
      actor,
      {
        golden: golden.name,
        provider: golden.provider,
        harness: selection.harness,
        model: selection.model,
        ...(selection.size === undefined ? {} : { size: selection.size }),
        ...(selection.skills === undefined ? {} : { skills: selection.skills }),
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(selection.repo ? { repo: selection.repo } : {}),
        ...(selection.prompt ? { prompt: selection.prompt } : {}),
      },
      {
        newId: () => op.sandboxId,
        ...(runtime
          ? {
              privateVisibility: true as const,
              runtime: {
                async start(request) {
                  await assertCurrent();
                  const agent = await runtime.start(request);
                  return {
                    ...agent,
                    async prompt(prompt) {
                      await assertCurrent();
                      return agent.prompt(prompt);
                    },
                    ...(agent.prepareWorkspace && {
                      prepareWorkspace: async (...args: Parameters<NonNullable<typeof agent.prepareWorkspace>>) => {
                        await assertCurrent();
                        return agent.prepareWorkspace!(...args);
                      },
                    }),
                    ...(agent.installSkills && {
                      installSkills: async (...args: Parameters<NonNullable<typeof agent.installSkills>>) => {
                        await assertCurrent();
                        return agent.installSkills!(...args);
                      },
                    }),
                  };
                },
              },
            }
          : {}),
        ...(input.extensionHeadroomSeconds === undefined
          ? {}
          : { extensionHeadroomSeconds: input.extensionHeadroomSeconds }),
      },
    );
    return { providerSandboxId: launched.sandbox.providerSandboxId };
  } catch (error) {
    if (!allocationAttempted || providerRefused)
      throw new ChildLaunchNotAllocated(providerRefused ? "provider_refused" : "preallocation_rejected", guard, error);
    throw error;
  }
}
