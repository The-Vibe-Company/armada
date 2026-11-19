import { assertLaunchSecretBindings, type Sql, VaultError } from "@armada/core/server";
import { createRuntimeEnvironmentDelivery } from "./runtime-launch-environment.ts";
import { readRuntimeTemplateEnvironment } from "./runtime-readable-variables.ts";

type Actor = { userId: string; orgId: string };

export function createModalRuntimeEnvironment(
  sql: Sql,
  key: string,
  clock?: Parameters<typeof createRuntimeEnvironmentDelivery>[2],
) {
  const deliver = createRuntimeEnvironmentDelivery(sql, key, clock);
  return {
    async validate(actor: Actor, id: string) {
      const { bindings } = await readRuntimeTemplateEnvironment(sql, actor, id, "modal");
      await assertLaunchSecretBindings(sql, actor, bindings);
    },
    async deliver(actor: Actor, id: string, epoch?: string, signal?: AbortSignal) {
      const { bindings } = await readRuntimeTemplateEnvironment(sql, actor, id, "modal");
      if (!bindings.length) return;
      return deliver({
        provider: "modal",
        id,
        ownerId: actor.userId,
        epoch,
        signal,
        load: async (tx) => {
          const source = await readRuntimeTemplateEnvironment(tx, actor, id, "modal");
          if (!source.bindings.length) throw new VaultError("conflict", "Runtime environment admission changed.");
          return { ...source, orgId: actor.orgId };
        },
      });
    },
  };
}
