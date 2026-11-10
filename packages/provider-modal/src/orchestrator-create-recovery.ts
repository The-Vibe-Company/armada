import { createHash } from "node:crypto";
import type { OrchestratorCreateRecoveryProof, OrchestratorCreateRecoveryRequest } from "@armada/core";
import type { Sandbox } from "modal";
import { refusal } from "./errors.ts";
import type { Machine, ModalStore, Scope } from "./ports.ts";
import { scopeKey } from "./store.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** The provider owns all physical IDs and generation discovery. No cloud mutation
 * occurs outside its normal authenticated scope/lease and exact named ownership. */
export function createOrchestratorCreateRecovery(input: {
  store: ModalStore;
  scope: Scope;
  sourceScope: Scope;
  assertSource(row: Machine): void;
  namedOwned(row: Machine): Promise<Sandbox>;
}) {
  function assert(row: Machine, request: OrchestratorCreateRecoveryRequest) {
    input.assertSource(row);
    const { target } = request;
    const registered = request.originalSandbox;
    const expanded = !!registered || !!request.intendedSandboxId;
    if (request.intendedSandboxId && row.info.labels.sandbox !== request.intendedSandboxId)
      throw refusal("conflict", "Intended registration changed.");
    if (
      registered &&
      (registered.sandboxId !== row.info.labels.sandbox ||
        registered.providerSandboxId !== row.info.id ||
        !/^[1-9][0-9]*$/.test(registered.sqlGeneration) ||
        (registered.nativeGeneration !== null && registered.nativeGeneration !== String(row.generation)))
    )
      throw refusal("conflict", "Registered generation binding changed.");
    if (
      request.version !== 1 ||
      !UUID.test(request.createOperationId) ||
      !UUID.test(request.recoveryOperationId) ||
      request.orgId !== input.scope.orgId ||
      request.ownerId !== input.scope.userId ||
      input.scope.visibility !== "private" ||
      target.provider !== "modal" ||
      target.orgId !== request.orgId ||
      target.visibility !== "private" ||
      target.sourceGoldenVisibility !== input.sourceScope.visibility ||
      !target.modal ||
      ["workspace", "environment", "appId"].some(
        (key) =>
          target.modal?.[key as keyof typeof target.modal] !== input.scope.binding[key as keyof Scope["binding"]],
      ) ||
      !UUID.test(request.orchestratorId) ||
      !UUID.test(request.ownerId) ||
      !UUID.test(request.orgId) ||
      row.runtimePolicy !== "explicit-vm-v1" ||
      row.runtimeEvidence?.physicalId !== row.physicalId ||
      row.runtimeEvidence?.generation !== 1 ||
      row.golden ||
      row.generation !== 1 ||
      !row.physicalId ||
      row.launchUserId !== request.ownerId ||
      !(
        expanded
          ? ["booting", "active", "checkpoint", "snapshot", "stopped", "terminate", "deleting", "deleted"]
          : ["booting", "deleting", "deleted"]
      ).includes(row.phase) ||
      (expanded
        ? row.orchestratorCheckpoint?.receipt.conversationId != null
        : !!row.orchestratorCheckpoint || !!row.recoveryImageId) ||
      !row.sourceImage ||
      row.sourceImage.name !== request.providerSnapshotId ||
      row.sourceImage.imageId !== row.imageId ||
      row.sourceImage.scopeKey !== scopeKey(input.sourceScope) ||
      row.physicalName !== `armada-${createHash("sha256").update(row.info.id).digest("hex").slice(0, 32)}-1` ||
      row.info.labels.operation !== request.createOperationId ||
      row.info.labels.orchestrator !== request.orchestratorId ||
      row.info.labels.owner !== request.ownerId ||
      row.info.labels.org !== request.orgId ||
      row.info.labels.visibility !== "private" ||
      !UUID.test(row.info.labels.sandbox ?? "")
    )
      throw refusal("conflict", "Create recovery binding changed; resource retained.");
    const saved = row.orchestratorCreateRecovery;
    if (
      saved &&
      ([
        "version",
        "createOperationId",
        "recoveryOperationId",
        "orchestratorId",
        "ownerId",
        "orgId",
        "providerSnapshotId",
      ].some(
        (key) =>
          saved.request[key as keyof OrchestratorCreateRecoveryRequest] !==
          request[key as keyof OrchestratorCreateRecoveryRequest],
      ) ||
        saved.request.target.provider !== request.target.provider ||
        saved.request.target.orgId !== request.target.orgId ||
        saved.request.target.visibility !== request.target.visibility ||
        saved.request.target.sourceGoldenVisibility !== request.target.sourceGoldenVisibility ||
        ["workspace", "environment", "appId"].some(
          (key) =>
            saved.request.target.modal?.[key as keyof Scope["binding"]] !==
            request.target.modal?.[key as keyof Scope["binding"]],
        ) ||
        saved.request.intendedSandboxId !== request.intendedSandboxId ||
        saved.request.originalSandbox?.sandboxId !== registered?.sandboxId ||
        saved.request.originalSandbox?.providerSandboxId !== registered?.providerSandboxId ||
        saved.request.originalSandbox?.sqlGeneration !== registered?.sqlGeneration ||
        saved.request.originalSandbox?.nativeGeneration !== registered?.nativeGeneration ||
        saved.binding.originalSandbox?.sandboxId !== registered?.sandboxId ||
        saved.binding.originalSandbox?.providerSandboxId !== registered?.providerSandboxId ||
        saved.binding.originalSandbox?.sqlGeneration !== registered?.sqlGeneration ||
        saved.binding.originalSandbox?.nativeGeneration !== registered?.nativeGeneration ||
        saved.binding.version !== 1 ||
        saved.binding.provider !== "modal" ||
        saved.binding.createOperationId !== request.createOperationId ||
        saved.binding.recoveryOperationId !== request.recoveryOperationId ||
        saved.binding.orchestratorId !== request.orchestratorId ||
        saved.binding.ownerId !== request.ownerId ||
        saved.binding.orgId !== request.orgId ||
        (saved.state === "terminated" && row.phase !== "deleted") ||
        saved.binding.physicalId !== row.physicalId ||
        saved.binding.providerSandboxId !== row.info.id ||
        saved.binding.physicalName !== row.physicalName ||
        saved.binding.generation !== row.generation ||
        saved.binding.sandboxId !== row.info.labels.sandbox)
    )
      throw refusal("conflict", "Create recovery belongs to another incarnation or operation.");
    if (!saved && !expanded && row.phase !== "booting")
      throw refusal("conflict", "No exact recovery receipt for this phase.");
  }
  async function recover(request: OrchestratorCreateRecoveryRequest, dispatch: boolean) {
    const found = await input.store.findByRequestKey(request.createOperationId);
    if (!found) throw refusal("unavailable", "Original create reservation is not confirmed.");
    return input.store.lease(found.info.id, async (row, save) => {
      const current = await input.store.findByRequestKey(request.createOperationId);
      if (!current || current.info.id !== row.info.id)
        throw refusal("conflict", "Original reservation changed; resource retained.");
      assert(row, request);
      if (row.orchestratorCreateRecovery?.state === "terminated")
        return { ...row.orchestratorCreateRecovery.binding, state: "terminated" as const };
      if (!dispatch && !row.orchestratorCreateRecovery) return null;
      const sb = await input.namedOwned(row); // Pinned App/name/environment and exact ownership tags.
      if (sb.sandboxId !== row.physicalId)
        throw refusal("conflict", "Named physical identity changed; resource retained.");
      if (!row.orchestratorCreateRecovery) {
        const binding: Omit<OrchestratorCreateRecoveryProof, "state"> = {
          version: 1,
          provider: "modal",
          createOperationId: request.createOperationId,
          recoveryOperationId: request.recoveryOperationId,
          orchestratorId: request.orchestratorId,
          ownerId: request.ownerId,
          orgId: request.orgId,
          sandboxId: row.info.labels.sandbox!,
          providerSandboxId: row.info.id,
          physicalId: row.physicalId!,
          physicalName: row.physicalName,
          generation: 1,
          ...(request.originalSandbox ? { originalSandbox: { ...request.originalSandbox } } : {}),
        };
        row.orchestratorCreateRecovery = { request, binding, state: "dispatched" };
        row.phase = "deleting";
        await save(row); // Immutable native binding fence BEFORE cloud termination.
      }
      let exit = await sb.poll();
      if (exit === null && dispatch) {
        // A manual recover invocation may retry idempotent termination ONLY of
        // this freshly revalidated physical identity. Never allocate or resume.
        await sb.terminate({ wait: true });
        exit = await sb.poll();
      }
      if (exit === null || !Number.isInteger(exit)) return null;
      row.orchestratorCreateRecovery!.state = "terminated";
      row.phase = "deleted";
      await save(row); // Durable positive proof; neither a 404 nor a preexisting deleted row suffices.
      return { ...row.orchestratorCreateRecovery!.binding, state: "terminated" as const };
    });
  }
  return {
    recover: (request: OrchestratorCreateRecoveryRequest) => recover(request, true),
    read: (request: OrchestratorCreateRecoveryRequest) => recover(request, false),
  };
}
