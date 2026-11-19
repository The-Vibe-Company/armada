import type { ModalBinding, Sql } from "@armada/core";
import { modalDeploymentId } from "@armada/provider-modal";
import { createModalReaperOwnership } from "./modal-reaper-ownership.ts";
import { createProviderReaperLane, type ProviderReaperSource } from "./provider-reaper.ts";

interface ModalInventoryRegistration {
  app_id: string;
  app_name: string;
  environment: string;
  authority_scope: "org" | "user";
  authority_owner_id: string;
}

type OpenInventory = (
  registration: ModalInventoryRegistration,
  binding: ModalBinding,
  deploymentId: string,
  signal: AbortSignal,
) => Promise<ProviderReaperSource["inventory"]>;

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
        return {
          provider: "modal",
          sourceId: appId,
          deploymentId,
          inventory: {
            async *listInventory() {
              signal.throwIfAborted();
              const connection = await openInventory(registration, binding, deploymentId, signal);
              signal.throwIfAborted();
              yield* connection.listInventory(signal);
            },
          },
          lookupOwnership: createModalReaperOwnership(sql, binding),
        } satisfies ProviderReaperSource;
      });
    },
    options.log,
    options.now,
  );
}
