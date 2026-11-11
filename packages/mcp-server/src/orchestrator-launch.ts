import {
  createSqlSandboxStore,
  type GoldenActor,
  type Harness,
  type HarnessCredentials,
  isNonMutatingProviderRefusal,
  type LaunchRequest,
  type LaunchStores,
  launchSandbox,
  PROVIDER_LIMITS,
  type Provider,
  ProviderError,
  type Sql,
} from "@armada/core/server";
import { diagnosticStep, type OrchestratorDiagnostics } from "./orchestrator-diagnostics.ts";
import { orchestratorParentLaunchRequest } from "./orchestrator-launch-request.ts";
import type { OrchestratorCreateHooks } from "./orchestrator-runtime.ts";
import { OrchestratorRuntimeError, type RuntimeReservation } from "./orchestrator-runtime-store.ts";

/** Reuses the v2 launcher; named credentials and size policy are resolved by their
 * actual producer adapters before invoking this function. Never resolves legacy defaults.
 * No ordinary-worker launch path is modified. */
export async function launchOrchestratorParent(input: {
  sql: Sql;
  provider: Provider;
  stores: LaunchStores;
  actor: GoldenActor;
  request: LaunchRequest;
  reservation: RuntimeReservation;
  diagnostics?: OrchestratorDiagnostics;
  hooks?: OrchestratorCreateHooks;
  /** Exact #612 resolver signature and binding, not a legacy default credential port. */
  account: {
    credentialId: string;
    credentialVersion: number;
    resolve(
      actor: GoldenActor,
      harness: Harness,
      credentialId: string,
      credentialVersion: number,
    ): Promise<HarnessCredentials>;
  };
}): Promise<void> {
  const { sql, provider, actor, request, reservation } = input;
  const identity = reservation.identity;
  input.diagnostics?.stage("launcher_preflight");
  if (
    input.account.credentialId !== identity.configuration.modelAccountId ||
    !Number.isSafeInteger(input.account.credentialVersion) ||
    input.account.credentialVersion < 1
  )
    throw new OrchestratorRuntimeError("invalid_request");
  // A missing producer migration cannot be discovered only after a billable fork.
  input.diagnostics?.stage("launcher_schema");
  try {
    await sql.query(`select credential_id,credential_version from public.sandboxes limit 0`);
  } catch (error) {
    input.diagnostics?.capture(error);
    throw new OrchestratorRuntimeError("unavailable");
  }
  input.diagnostics?.stage("launcher_configuration");
  if (
    !sql.transaction ||
    actor.userId !== identity.ownerId ||
    actor.orgId !== identity.orgId ||
    request.provider !== identity.configuration.provider ||
    request.harness !== identity.configuration.harness ||
    request.model !== identity.configuration.model ||
    request.reasoningEffort !== identity.configuration.reasoningEffort ||
    request.prompt !== undefined
  )
    throw new OrchestratorRuntimeError("invalid_request");
  const sandboxId = crypto.randomUUID();
  let registeredGeneration: number | undefined;
  input.diagnostics?.bind({ sandboxId });
  const sandboxes = {
    ...input.stores.sandboxes,
    update: async (id: string, patch: Parameters<LaunchStores["sandboxes"]["update"]>[1]) => {
      await input.hooks?.assertCurrent?.();
      if (!sql.transaction || id !== sandboxId || registeredGeneration === undefined)
        throw new OrchestratorRuntimeError("conflict");
      await sql.transaction(async (tx) => {
        const live = await tx.query(
          `select s.id from public.orchestrators o join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
           join public.orchestrator_operations p on p.orchestrator_id=o.id and p.id=$5
           join public.sandboxes s on s.id=o.sandbox_id
           where o.id=$1 and o.owner_id=$2 and o.org_id=$3 and o.revision=$4 and p.revision=o.revision and p.state='pending' and p.action='create'
           and s.id=$6 and s.lifecycle_generation=$7 and s.stop_requested_at is null and s.deleted_at is null for update of o,m,p,s`,
          [
            identity.id,
            actor.userId,
            actor.orgId,
            reservation.operation.revision,
            reservation.operation.id,
            sandboxId,
            registeredGeneration,
          ],
        );
        if (live.rows.length !== 1) throw new OrchestratorRuntimeError("conflict");
        await createSqlSandboxStore(tx, { turnModels: true }).update(id, patch);
      });
    },
    insert: async (record: Parameters<LaunchStores["sandboxes"]["insert"]>[0]) =>
      diagnosticStep(input.diagnostics, "registration", async () => {
        input.diagnostics?.bind({ sandboxId });
        if (!sql.transaction || record.id !== sandboxId || record.visibility !== "private")
          throw new OrchestratorRuntimeError("conflict");
        const saved = await sql.transaction(async (tx) => {
          const current = await tx.query(
            `select o.id from public.orchestrators o join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
        where o.id=$1 and o.owner_id=$2 and o.org_id=$3 and o.revision=$4 and o.state='creating' and o.sandbox_id is null for update of o,m`,
            [identity.id, actor.userId, actor.orgId, reservation.operation.revision],
          );
          if (!current.rows.length) throw new OrchestratorRuntimeError("conflict");
          const selectedRecord = {
            ...record,
            credentialId: input.account.credentialId,
            credentialVersion: input.account.credentialVersion,
          };
          const saved = await createSqlSandboxStore(tx, { turnModels: true }).insert(selectedRecord);
          if (
            Reflect.get(saved, "credentialId") !== input.account.credentialId ||
            Reflect.get(saved, "credentialVersion") !== input.account.credentialVersion
          )
            throw new OrchestratorRuntimeError("unavailable");
          await tx.query(`update public.orchestrators set sandbox_id=$2 where id=$1`, [identity.id, saved.id]);
          const raw = (
            await tx.query<{ lifecycle_generation: string | number }>(
              "select lifecycle_generation from public.sandboxes where id=$1",
              [saved.id],
            )
          ).rows[0];
          const generation = Number(raw?.lifecycle_generation);
          if (!Number.isSafeInteger(generation) || generation < 1) throw new OrchestratorRuntimeError("conflict");
          return { ...saved, lifecycleGeneration: generation };
        });
        registeredGeneration = saved.lifecycleGeneration;
        input.diagnostics?.stage("initialization");
        return saved;
      }),
  };
  const routed = new Proxy(provider, {
    get(target, key) {
      if (key === "fork")
        return (fork: Parameters<Provider["fork"]>[0]) =>
          diagnosticStep(input.diagnostics, "fork", () =>
            target
              .fork({
                ...fork,
                idempotencyKey: reservation.operation.id,
                labels: { ...fork.labels, orchestrator: identity.id, operation: reservation.operation.id },
              })
              .catch((error: unknown) => {
                if (
                  isNonMutatingProviderRefusal(error) &&
                  error instanceof ProviderError &&
                  error.code === "payment_required"
                )
                  reservation.createForkRefusal = "provider_payment_required";
                throw error;
              }),
          );
      // Logical-ID cleanup cannot atomically compare our native incarnation.
      // Never let an old catch stop a replacement: exact recovery owns all
      // failed managed-create cleanup, even before public registration.
      if (key === "stop" || key === "delete")
        return async () => {
          throw new OrchestratorRuntimeError("conflict");
        };
      const value = Reflect.get(target, key);
      if (
        typeof value === "function" &&
        ["get", "exec", "prepareNativeHarnessCwd", "configureMcp"].includes(String(key))
      )
        return async (...args: unknown[]) => {
          await input.hooks?.assertCurrent?.();
          try {
            return await value.apply(target, args);
          } catch (error) {
            input.diagnostics?.capture(error);
            throw error;
          }
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // Preserve the actual604 lifecycle object and its registry/prototype methods;
  // replace only account selection. Native admission/hydration/publication must not disappear.
  const credentials = new Proxy(input.stores.credentials, {
    get(target, key) {
      if (key === "resolve") {
        return (actor: GoldenActor, harness: Harness) =>
          diagnosticStep(input.diagnostics, "credential_resolution", async () => {
            const credentials = await input.account.resolve(
              actor,
              harness,
              input.account.credentialId,
              input.account.credentialVersion,
            );
            const binding = Reflect.get(credentials, "binding");
            if (
              !binding ||
              binding.credentialId !== input.account.credentialId ||
              binding.credentialVersion !== input.account.credentialVersion
            )
              throw new OrchestratorRuntimeError("unavailable");
            input.diagnostics?.stage("launcher_preflight");
            return credentials;
          });
      }
      const value = Reflect.get(target, key, target);
      if (typeof value === "function" && (key === "admit" || key === "hydrateNative"))
        return (...args: unknown[]) =>
          diagnosticStep(input.diagnostics, key === "admit" ? "credential_admission" : "native_hydration", async () => {
            await input.hooks?.assertCurrent?.();
            return value.apply(target, args);
          });
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await launchSandbox(
    routed,
    {
      ...input.stores,
      sandboxes,
      credentials,
      // Binding validation and persistence remain ordinary launch policy. Native
      // preparation runs once through the operation-bound backend after launch
      // publication, before installing authority. Do not pass the launch proxy's
      // SQL callbacks into the lifecycle's serialized native I/O transaction.
      ...(input.stores.connections ? { connections: { ...input.stores.connections, prepare: async () => {} } } : {}),
    },
    actor,
    {
      ...orchestratorParentLaunchRequest(identity.configuration, request),
      ...{ credentialId: input.account.credentialId },
      visibility: "private",
      ttlSeconds: PROVIDER_LIMITS[identity.configuration.provider].maxTtlSeconds,
    },
    {
      newId: () => sandboxId,
      privateParent: true,
      onInitialization: (stage) => input.diagnostics?.stage(stage),
      beforeFork: async (id) => {
        await input.hooks?.beforeFork(id);
      },
      onRegistered: async (saved) => {
        const generation = saved.lifecycleGeneration;
        if (generation === undefined || !Number.isSafeInteger(generation) || generation < 1)
          throw new OrchestratorRuntimeError("conflict");
        await diagnosticStep(input.diagnostics, "registration", async () =>
          input.hooks?.registered({ ...saved, lifecycleGeneration: generation }),
        );
      },
    },
  );
}
