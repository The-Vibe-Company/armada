import { type ApplicationSecretBinding, type Harness, validateReadableVariables } from "@armada/core";
import { resolveLaunchSecrets, type Sql, VaultError } from "@armada/core/server";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "./runtime-enrolment.ts";

type RuntimeClock = Parameters<typeof createRuntimeCommands>[2];

export interface RuntimeEnvironmentSource {
  orgId: string;
  harness: Harness;
  variables: Record<string, string>;
  bindings: ApplicationSecretBinding[];
}

export function createRuntimeEnvironmentDelivery(sql: Sql, key: string, clock?: RuntimeClock) {
  const commands = createRuntimeCommands(createRuntimeEnrolments(sql, key), key, clock);
  return async (input: {
    provider: "docker" | "modal";
    ownerId: string;
    id: string;
    load(tx: Sql): Promise<RuntimeEnvironmentSource>;
    epoch?: string | undefined;
    signal?: AbortSignal | undefined;
  }) => {
    const { id, provider, ownerId, signal } = input;
    if (!sql.transaction) throw new VaultError("unavailable", "Runtime environment delivery is unavailable.");
    const transaction = sql.transaction.bind(sql);
    let requestId: string | undefined;
    const accepts = (body: Record<string, unknown>) =>
      body.version === 1 &&
      body.requestId === requestId &&
      body.error === undefined &&
      (body.result as { acknowledged?: boolean } | undefined)?.acknowledged === true;
    const reply = await commands.callPrepared(
      ownerId,
      "configureReadableVariables",
      async () => {
        const prepared = await transaction(async (tx) => {
          const local = scopedRuntimeSql(tx);
          const locked = createRuntimeEnrolments(local, key);
          signal?.throwIfAborted();
          await locked.lockSourceMembers(tx, id, ownerId);
          const source = await input.load(tx);
          const secrets = await resolveLaunchSecrets(
            local,
            { userId: ownerId, orgId: source.orgId },
            source.bindings,
            key,
          );
          const variables = validateReadableVariables({ ...source.variables, ...secrets });
          return locked.withOwner(id, ownerId, async (_tx, scope) => {
            if (scope.provider !== provider || (input.epoch !== undefined && scope.epoch !== input.epoch))
              throw new VaultError("conflict", "Runtime environment admission changed.");
            signal?.throwIfAborted();
            const request = {
              version: 1 as const,
              requestId: `${provider}_variables_${id}_${scope.epoch}`,
              sandboxId: id,
              op: "configureReadableVariables" as const,
              harness: source.harness,
              variables,
              ...(provider === "modal" ? { secretKeys: source.bindings.map(({ key }) => key).sort() } : {}),
            };
            await createRuntimeCommands(locked, key, clock).enqueue(ownerId, request, scope.epoch);
            return { request, epoch: scope.epoch };
          });
        });
        requestId = prepared.request.requestId;
        return {
          request: prepared.request,
          options: {
            expectedEpoch: prepared.epoch,
            timeoutMs: 60000,
            ...(signal ? { signal } : {}),
            accept: (candidate) => accepts(candidate.body),
          },
        };
      },
      provider,
      id,
    );
    if (reply.status !== 200 || !accepts(reply.body))
      throw new VaultError("unavailable", "Runtime variable delivery is unavailable.");
    return reply.epoch;
  };
}
