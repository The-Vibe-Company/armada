import { assertLaunchSecretBindings, type Sql, VaultError } from "@armada/core/server";
import { createRuntimeEnvironmentDelivery } from "./runtime-launch-environment.ts";
import { readRuntimeTemplateEnvironment } from "./runtime-readable-variables.ts";

type Actor = { userId: string; orgId: string };

export function createGoldenRuntimeEnvironment(
  sql: Sql,
  key: string,
  clock?: Parameters<typeof createRuntimeEnvironmentDelivery>[2],
) {
  const deliver = createRuntimeEnvironmentDelivery(sql, key, clock);
  return {
    async validate(provider: "boat" | "modal", actor: Actor, id: string) {
      const { bindings } = await readRuntimeTemplateEnvironment(sql, actor, id, provider);
      await assertLaunchSecretBindings(sql, actor, bindings);
    },
    async deliver(provider: "boat" | "modal", actor: Actor, id: string, epoch?: string, signal?: AbortSignal) {
      const { bindings } = await readRuntimeTemplateEnvironment(sql, actor, id, provider);
      if (!bindings.length) return;
      return deliver({
        provider,
        id,
        ownerId: actor.userId,
        epoch,
        signal,
        load: async (tx) => {
          const source = await readRuntimeTemplateEnvironment(tx, actor, id, provider);
          if (!source.bindings.length) throw new VaultError("conflict", "Runtime environment admission changed.");
          return { ...source, orgId: actor.orgId };
        },
      });
    },
  };
}
