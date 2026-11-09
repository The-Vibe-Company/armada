import { cache } from "react";
import { type AccountControl, createAccountControl } from "@/lib/account-control";
import { ControlError } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import {
  type AccountUsage,
  type AuthCapabilities,
  KIND_INFO,
  type LaunchAccounts,
  type ModelAccount,
} from "@/lib/model-accounts";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";

/** The account control client acting as the signed-in viewer, or null when no Armada server is configured. */
export async function viewerAccountControl(): Promise<AccountControl | null> {
  const viewer = await requireViewer();
  const url = mcpUrl();
  if (!url || !viewer.token) return null;
  return createAccountControl({ serverUrl: url, token: viewer.token });
}

/**
 * The model accounts of the viewer and of the selected org. `legacy` is a server older than named accounts: its
 * keys still launch, but they cannot be listed by name here. A failed read is an error, never an empty list.
 */
export type AccountList =
  | { state: "ready"; orgId: string; orgName: string; accounts: ModelAccount[] }
  | { state: "legacy" }
  | { state: "no-org" }
  | { state: "not-configured" }
  | { state: "error"; message: string };

export const listSelectedAccounts = cache(async (): Promise<AccountList> => {
  const selected = await selectedOrganization();
  if (!selected) return { state: "no-org" };
  const control = await viewerAccountControl();
  if (!control) return { state: "not-configured" };
  try {
    const { accounts, legacy } = await control.list(selected.org.id);
    if (legacy && accounts.length === 0) return { state: "legacy" };
    return { state: "ready", orgId: selected.org.id, orgName: selected.org.name, accounts };
  } catch (error) {
    if (error instanceof ControlError) return { state: "error", message: error.message };
    throw error;
  }
});

export function launchAccounts(list: AccountList, now: number): LaunchAccounts {
  if (list.state === "ready") return { state: "ready", accounts: list.accounts, orgName: list.orgName, now };
  if (list.state === "legacy") return { state: "legacy" };
  return {
    state: "unavailable",
    reason:
      list.state === "error"
        ? list.message
        : list.state === "no-org"
          ? "Create an organization first."
          : "The Armada server is not configured.",
  };
}

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
  const asked = accounts.filter((account) => KIND_INFO[account.kind].billing === "subscription");
  const failed = (account: ModelAccount): AccountUsage => ({
    accountId: account.id,
    version: account.version,
    status: "error",
    observedAt: null,
    windows: [],
    extraUsage: null,
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
