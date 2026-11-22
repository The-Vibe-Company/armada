import type { MemberRole, ProviderRegistry, Sql } from "@armada/core";
import { createSqlVaultStore } from "@armada/core/server";
import { settleDetachedModalCollections } from "@armada/provider-modal";
import { createSqlData } from "./data.ts";
import { providerRegistry } from "./http.ts";
import { createModalIntegration } from "./modal-integration.ts";
import { createObservedBoatProvider } from "./observed-boat.ts";
import { createSandboxArmadaAccess } from "./sandbox-armada-access.ts";
import { requestNativeDrainStop, settleHistoricalManagedModalDeletion } from "./sandbox-lifecycle.ts";
import { deleteSandboxWithActivity } from "./sandbox-rest-controls.ts";

export function configureNativeDrain(
  sql: Sql,
  provider: "modal" | "boat",
  actorId: string,
  env: Record<string, string | undefined>,
  allowHistoricalModal = false,
) {
  const encryptionKey = env.ARMADA_ENCRYPTION_KEY;
  const publicUrl = env.ARMADA_PUBLIC_URL;
  if (!encryptionKey || !publicUrl) throw new Error("Native drain provider configuration is incomplete.");
  const vault = createSqlVaultStore(sql);
  const scopedAccess = createSandboxArmadaAccess({ sql, encryptionKey, publicUrl });
  let modal: ReturnType<typeof createModalIntegration> | undefined;
  const modalIntegration = () => (modal ??= createModalIntegration({ sql, vault, encryptionKey, publicUrl }));
  const deploymentId = env.ARMADA_BOAT_DEPLOYMENT_ID?.trim();
  const providers = providerRegistry({
    vault,
    encryptionKey,
    providerFor: (apiKey) => createObservedBoatProvider({ apiKey, ...(deploymentId ? { deploymentId } : {}) }),
    modalTokensFor: async (target, caller) => modalIntegration().modalTokensFor(target, caller),
    modalProviderFor: async (tokens, binding, context) => {
      const sandboxId = context.target.id;
      if (!sandboxId) throw new Error("Native drain requires a persisted Modal sandbox.");
      return modalIntegration().modalProviderFor(tokens, binding, context);
    },
  });
  const remove = createNativeDrainRemoval(sql, provider, actorId, scopedAccess, providers, allowHistoricalModal);
  return { remove, settle: settleDetachedModalCollections };
}

export function createNativeDrainRemoval(
  sql: Sql,
  provider: "modal" | "boat",
  actorId: string,
  scopedAccess: Pick<
    ReturnType<typeof createSandboxArmadaAccess>,
    "beforeNativeDrainDelete" | "beforeNativeModalDrainDelete" | "revokeNativeDrainParent"
  >,
  providers: ProviderRegistry,
  allowHistoricalModal: boolean,
) {
  const deletionPreparation = {
    boat: { beforeNativeDrainDelete: scopedAccess.beforeNativeDrainDelete },
    modal: { beforeNativeDrainDelete: scopedAccess.beforeNativeModalDrainDelete },
  }[provider];
  const managedSettlement = { boat: undefined, modal: settleHistoricalManagedModalDeletion }[provider];
  const data = createSqlData(sql);
  return async (row: { id: string; org_id: string; role: MemberRole | null }) => {
    if (!row.role) throw new Error("The operator has no organization membership.");
    const settled = allowHistoricalModal
      ? await managedSettlement?.(sql, row, actorId, scopedAccess.revokeNativeDrainParent)
      : undefined;
    if (settled === "without-proof") return settled;
    if (settled === "already-deleted") return;
    const managed = settled === "with-activity";
    const source = managed
      ? createSqlData(sql, undefined, undefined, { ...row, revoke: scopedAccess.revokeNativeDrainParent })
      : data;
    const { sandboxes } = source({ userId: actorId, orgs: [{ orgId: row.org_id, role: row.role }], via: "service" });
    const target = await sandboxes.get(row.id);
    if (target && (target.status === "ready" || target.status === "running")) {
      if (!(await requestNativeDrainStop(sql, target, provider, actorId)))
        throw new Error("Native drain could not admit strict preservation.");
      throw new Error("Native drain cannot delete before preservation and stop are confirmed.");
    }
    if ((target?.stopRequestedAt && !allowHistoricalModal) || target?.status === "stopping")
      throw new Error("Native drain is waiting for the stop to settle.");
    const result = await deleteSandboxWithActivity(
      sandboxes,
      {
        ...(managed ? {} : deletionPreparation),
        async resolve(target, caller) {
          if (target.provider !== provider || target.boatRuntime || target.runtimeTransport === "dialout")
            throw new Error("The sandbox route changed after inventory.");
          return providers.resolve(target, caller);
        },
      },
      row.id,
      "native-drain",
      allowHistoricalModal,
    );
    return result.drainProof;
  };
}
