import { cache } from "react";
import { type AccountControl, createAccountControl } from "@/lib/account-control";
import { ControlError } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import {
  type AccountList,
  type AccountUsage,
  type AuthCapabilities,
  KIND_INFO,
  type ModelAccount,
} from "@/lib/model-accounts";
import { type ConnectionTestChoices, matchesConnectionTestSandbox } from "@/lib/model-connection-check";
import { createClient } from "@/lib/supabase/server";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";

/** The account control client acting as the signed-in viewer, or null when no Armada server is configured. */
export async function viewerAccountControl(): Promise<AccountControl | null> {
  const viewer = await requireViewer();
  const url = mcpUrl();
  if (!url || !viewer.token) return null;
  return createAccountControl({ serverUrl: url, token: viewer.token });
}

export type { AccountList } from "@/lib/model-accounts";
export { launchAccounts } from "@/lib/model-accounts";

export const listSelectedAccounts = cache(async (): Promise<AccountList> => {
  const selected = await selectedOrganization();
  if (!selected) return { state: "no-org" };
  const control = await viewerAccountControl();
  if (!control) return { state: "not-configured" };
  try {
    const [{ accounts: listed, legacy, defaults }, models] = await Promise.all([
      control.list(selected.org.id),
      control.connectionModels(selected.org.id),
    ]);
    if (legacy && listed.length === 0) return { state: "legacy" };
    const accounts = listed.map((account) => {
      const declared = models.get(account.id);
      return declared ? { ...account, models: declared } : account;
    });
    return {
      state: "ready",
      orgId: selected.org.id,
      orgName: selected.org.name,
      accounts,
      ...(defaults ? { defaults } : {}),
    };
  } catch (error) {
    if (error instanceof ControlError) return { state: "error", message: error.message };
    throw error;
  }
});

/** How accounts can be connected on this deployment, or null (paste only) when the server does not say. */
export async function readAuthCapabilities(org: string): Promise<AuthCapabilities | null> {
  const control = await viewerAccountControl();
  return control ? control.authCapabilities(org) : null;
}

/** A usage read is metadata: the page does not wait on it for long. */
export const USAGE_TIMEOUT_MS = 5_000;

/**
 * The usage of each subscription account, read in parallel and bounded in time. API-key accounts are not asked:
 * they bill per token and have no allowance. A failed or slow read is an `error` report for that account only.
 */
export async function readAccountUsage(
  accounts: readonly ModelAccount[],
): Promise<Record<string, AccountUsage | null>> {
  const control = await viewerAccountControl();
  if (!control) return {};
  // #624 answers 404 for a revoked account: only active subscriptions are asked.
  const asked = accounts.filter(
    (account) => KIND_INFO[account.kind].billing === "subscription" && account.status === "active",
  );
  const failed = (account: ModelAccount): AccountUsage => ({
    accountId: account.id,
    version: account.version,
    status: "error",
    observedAt: null,
    windows: [],
    extraUsage: null,
    credits: [],
    hiddenWindows: 0,
    hiddenCredits: 0,
  });
  const entries = await Promise.all(
    asked.map(async (account) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<AccountUsage>((resolve) => {
        timer = setTimeout(() => resolve(failed(account)), USAGE_TIMEOUT_MS);
      });
      try {
        return [account.id, await Promise.race([control.usage(account.id), timeout])] as const;
      } catch (error) {
        if (error instanceof ControlError) return [account.id, failed(account)] as const;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return Object.fromEntries(entries);
}

/** Read recent eligible candidates per account/version under the viewer JWT. Submit rechecks binding. */
export async function readConnectionTestChoices(accounts: readonly ModelAccount[]): Promise<ConnectionTestChoices> {
  const [viewer, selected, supabase] = await Promise.all([requireViewer(), selectedOrganization(), createClient()]);
  if (!selected) return { state: "unavailable" };
  const eligible = accounts.filter(
    (account) =>
      account.status === "active" &&
      KIND_INFO[account.kind].billing === "api" &&
      (account.kind !== "opencode" || !!account.models?.length),
  );
  const reads = await Promise.all(
    eligible.map((account) =>
      supabase
        .from("sandboxes")
        .select(
          "id,owner_id,org_id,provider,boat_runtime,status,stop_requested_at,credential_id,credential_version,harness,created_at",
        )
        .eq("owner_id", viewer.id)
        .eq("org_id", selected.org.id)
        .in("provider", ["modal", "boat"])
        .or("provider.eq.modal,boat_runtime.eq.true")
        .is("stop_requested_at", null)
        .eq("credential_id", account.id)
        .eq("credential_version", account.version)
        .in("status", ["ready", "running"])
        .order("created_at", { ascending: false })
        .limit(50),
    ),
  );
  if (reads.some((read) => read.error)) return { state: "unavailable" };
  return {
    state: "ready",
    sandboxes: reads.flatMap(({ data }, index) =>
      (data ?? []).flatMap((row) =>
        matchesConnectionTestSandbox(row, {
          id: row.id,
          ownerId: viewer.id,
          orgId: selected.org.id,
          accountId: eligible[index]!.id,
          version: eligible[index]!.version,
        })
          ? [
              {
                id: row.id,
                accountId: eligible[index]!.id,
                version: eligible[index]!.version,
                provider: row.provider === "boat" ? ("boat" as const) : ("modal" as const),
                harness: row.harness,
                createdAt: row.created_at,
              },
            ]
          : [],
      ),
    ),
  };
}
