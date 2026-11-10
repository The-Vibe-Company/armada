import {
  createSqlSandboxStore,
  type GoldenActor,
  type Harness,
  type HarnessCredentials,
  isNonMutatingProviderRefusal,
  type LaunchStores,
  launchSandbox,
  type Provider,
  type Sql,
} from "@armada/core/server";
import type { ChildLaunchSelection, ChildOperation } from "./orchestrator-children.ts";

/** Local proof that this executor never attempted allocation, or the SDK explicitly refused
 * without mutation. Never reconstructed from guest JSON or absence in provider listings. */
export class ChildLaunchNotAllocated extends Error {
  constructor(readonly reason: "preallocation_rejected" | "provider_refused") {
    super("Child launch was not allocated.");
  }
}

/** Exact #612 af8a9c2 resolver projection. The binding MUST be returned and match;
 * a legacy resolver or incomplete #604 private-state pipeline is not support. */
export interface PinnedModelAccountResolver {
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
export async function launchOrchestratorChild(input: {
  extensionHeadroomSeconds?: number;
  sql: Sql;
  provider: Provider;
  stores: LaunchStores;
  namedCredentials: PinnedModelAccountResolver;
  operation: ChildOperation;
  selection: ChildLaunchSelection;
}): Promise<{ providerSandboxId: string }> {
  const { sql, provider, operation: op, selection } = input;
  let allocationAttempted = false;
  let providerRefused = false;
  try {
    if (!sql.transaction || op.action !== "launch") throw new Error("Child launch reservation unavailable.");
    const assertCurrent = async () => {
      const row = (
        await sql.query(
          `select c.id from public.orchestrator_child_operations c
      join public.orchestrators o on o.id=c.orchestrator_id
      join public.sandboxes s on s.id=o.sandbox_id
      join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
      where c.id=$1 and c.target_id=$2 and c.owner_id=$3 and c.org_id=$4 and c.action='launch'
      and c.orchestrator_id=$5 and c.parent_generation=$6 and c.parent_epoch=$7
      and c.state='pending' and c.dispatched_at is not null and o.state='ready'
      and s.lifecycle_generation=c.parent_generation and o.authority_epoch=c.parent_epoch`,
          [op.id, op.sandboxId, op.ownerId, op.orgId, op.orchestratorId, op.parentGeneration, op.parentEpoch],
        )
      ).rows[0];
      if (!row) throw new Error("Child launch admission is no longer current.");
    };
    // Actual #612/202 binding columns must exist BEFORE any billable allocation.
    try {
      await sql.query(`select credential_id,credential_version from public.sandboxes limit 0`);
    } catch {
      throw new Error("Child named account schema unavailable; no allocation was attempted.");
    }
    await assertCurrent();
    const actor: GoldenActor = { userId: op.ownerId, orgId: op.orgId, role: "member" };
    const golden = (await input.stores.goldens.list(op.orgId)).find((g) => g.id === selection.goldenId);
    if (!golden || golden.orgId !== op.orgId || provider.id !== golden.provider)
      throw new Error("Child golden unavailable.");
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
            await assertCurrent();
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
        if (["exec", "prompt", "prepareNativeHarnessCwd", "configureMcp"].includes(String(key))) {
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
          const saved = await createSqlSandboxStore(tx).insert({
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
        ...(input.extensionHeadroomSeconds === undefined
          ? {}
          : { extensionHeadroomSeconds: input.extensionHeadroomSeconds }),
      },
    );
    return { providerSandboxId: launched.sandbox.providerSandboxId };
  } catch (error) {
    if (!allocationAttempted || providerRefused)
      throw new ChildLaunchNotAllocated(providerRefused ? "provider_refused" : "preallocation_rejected");
    throw error;
  }
}
