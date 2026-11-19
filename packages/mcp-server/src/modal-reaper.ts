import type { ModalBinding, Sql } from "@armada/core";
import { modalDeploymentId } from "@armada/provider-modal";
import { NotFoundError } from "modal";
import { createModalReaperOwnership } from "./modal-reaper-ownership.ts";
import { createProviderReaperLane, decideInventoryMachine, type ProviderReaperSource } from "./provider-reaper.ts";

interface ModalInventoryRegistration {
  app_id: string;
  app_name: string;
  environment: string;
  authority_scope: "org" | "user";
  authority_owner_id: string;
}

type ModalReaperConnection = ProviderReaperSource["inventory"] & {
  openSandbox(machineId: string): Promise<{
    terminate(): Promise<unknown>;
    waitForTermination(signal: AbortSignal): Promise<number | null>;
  }>;
};

type OpenInventory = (
  registration: ModalInventoryRegistration,
  binding: ModalBinding,
  deploymentId: string,
  signal: AbortSignal,
) => Promise<ModalReaperConnection>;

export function modalReaperSql(sql: Sql) {
  return {
    async query<T>(query: string, params?: unknown[]) {
      if (!sql.transaction) return sql.query<T>(query, params);
      return sql.transaction(async (tx) => {
        await tx.query("set local statement_timeout = '5s'");
        return tx.query<T>(query, params);
      });
    },
  } satisfies Sql;
}

export function createModalReaper(
  sql: Sql,
  publicUrl: string,
  openInventory: OpenInventory,
  options: {
    log?: ((line: string) => void) | undefined;
    now?: () => number;
    onRegistrations?: (registrations: readonly ModalInventoryRegistration[]) => void;
  } = {},
) {
  const now = options.now ?? Date.now;
  const log = options.log ?? console.log;
  return createProviderReaperLane(
    async (signal) => {
      const { rows } = await sql.query<ModalInventoryRegistration>(
        `select distinct app_id, app_name, environment, authority_scope, authority_owner_id
       from public.modal_server_apps
       where authority_scope='user' or authority_owner_id=org_id`,
      );
      signal.throwIfAborted();
      options.onRegistrations?.(rows);
      return rows.map((registration) => {
        const { app_id: appId, environment } = registration;
        const binding: ModalBinding = { workspace: `app:${appId}`, appId, environment };
        const deploymentId = modalDeploymentId(environment, publicUrl);
        const lookupBeforeDelete = createModalReaperOwnership(sql, binding, true);
        let connection: ModalReaperConnection;
        return {
          provider: "modal",
          sourceId: appId,
          deploymentId,
          inventory: {
            async *listInventory() {
              signal.throwIfAborted();
              connection = await openInventory(registration, binding, deploymentId, signal);
              signal.throwIfAborted();
              yield* connection.listInventory(signal);
            },
          },
          lookupOwnership: createModalReaperOwnership(sql, binding),
          async deleteMachine(machine, reason, signal) {
            if (reason !== "unknown") return false;
            const ownership = await lookupBeforeDelete(machine, signal);
            const checkedAt = now();
            if (decideInventoryMachine(machine, deploymentId, ownership, checkedAt) !== "unknown") return false;
            signal.throwIfAborted();
            const event = {
              event: "provider_reaper_delete",
              provider: "modal",
              source: appId,
              reason,
              machineId: machine.machineId,
              ageMs: checkedAt - machine.createdAt.getTime(),
            };
            log(JSON.stringify({ ...event, outcome: "attempt" }));
            try {
              const sandbox = await connection.openSandbox(machine.machineId);
              signal.throwIfAborted();
              await sandbox.terminate();
              log(JSON.stringify({ ...event, outcome: "submitted" }));
              signal.throwIfAborted();
              if ((await sandbox.waitForTermination(signal)) === null)
                throw new Error("Modal termination is not yet confirmed.");
            } catch (error) {
              const notFound =
                error instanceof NotFoundError ||
                (error instanceof Error && error.name === "ClientError" && Reflect.get(error, "code") === 5);
              if (!notFound) {
                log(JSON.stringify({ ...event, outcome: "retry" }));
                throw error;
              }
            }
            log(JSON.stringify({ ...event, outcome: "confirmed" }));
            return true;
          },
        } satisfies ProviderReaperSource;
      });
    },
    log,
    now,
  );
}
