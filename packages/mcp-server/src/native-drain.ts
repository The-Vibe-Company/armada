import type { MemberRole, ProviderRegistry, Sql } from "@armada/core";
import { createSqlVaultStore } from "@armada/core/server";
import { createSqlData } from "./data.ts";
import { providerRegistry } from "./http.ts";
import { createObservedBoatProvider } from "./observed-boat.ts";
import { createSandboxArmadaAccess } from "./sandbox-armada-access.ts";
import { requestNativeDrainStop } from "./sandbox-lifecycle.ts";
import { deleteSandboxWithActivity } from "./sandbox-rest-controls.ts";

export function configureNativeDrain(
  sql: Sql,
  provider: "boat",
  actorId: string,
  env: Record<string, string | undefined>,
) {
  const encryptionKey = env.ARMADA_ENCRYPTION_KEY;
  const publicUrl = env.ARMADA_PUBLIC_URL;
  if (!encryptionKey || !publicUrl) throw new Error("Native drain provider configuration is incomplete.");
  const vault = createSqlVaultStore(sql);
  const scopedAccess = createSandboxArmadaAccess({ sql, encryptionKey, publicUrl });
  const deploymentId = env.ARMADA_BOAT_DEPLOYMENT_ID?.trim();
  const providers = providerRegistry({
    vault,
    encryptionKey,
    providerFor: (apiKey) => createObservedBoatProvider({ apiKey, ...(deploymentId ? { deploymentId } : {}) }),
  });
  return { remove: createNativeDrainRemoval(sql, provider, actorId, scopedAccess, providers) };
}

export function createNativeDrainRemoval(
  sql: Sql,
  provider: "boat",
  actorId: string,
  scopedAccess: Pick<ReturnType<typeof createSandboxArmadaAccess>, "beforeNativeDrainDelete">,
  providers: ProviderRegistry,
) {
  const data = createSqlData(sql);
  return async (row: { id: string; org_id: string; role: MemberRole | null }) => {
    if (!row.role) throw new Error("The operator has no organization membership.");
    const { sandboxes } = data({ userId: actorId, orgs: [{ orgId: row.org_id, role: row.role }], via: "service" });
    const target = await sandboxes.get(row.id);
    if (target && (target.status === "ready" || target.status === "running")) {
      if (!(await requestNativeDrainStop(sql, target, provider, actorId)))
        throw new Error("Native drain could not admit strict preservation.");
      throw new Error("Native drain cannot delete before preservation and stop are confirmed.");
    }
    if (target?.stopRequestedAt || target?.status === "stopping")
      throw new Error("Native drain is waiting for the stop to settle.");
    const result = await deleteSandboxWithActivity(
      sandboxes,
      {
        beforeNativeDrainDelete: scopedAccess.beforeNativeDrainDelete,
        async resolve(target, caller) {
          if (target.provider !== provider || target.boatRuntime || target.runtimeTransport === "dialout")
            throw new Error("The sandbox route changed after inventory.");
          return providers.resolve(target, caller);
        },
      },
      row.id,
      "native-drain",
    );
    return result.drainProof;
  };
}
