import { type AgentDefault, type Harness, MODEL_CATALOG, MORPH_MODEL_IDS } from "@armada/core";
import { accountState, accountsFor, isUsable, launchDefault, type ModelAccount } from "./model-accounts";

/** Capacity refuses new launches; it does not imply that existing agents cannot send messages. */
export function modelsPageStatus(account: ModelAccount, now: number) {
  const state = accountState(account, now);
  if (state.needsAction) return { ...state, label: state.label === "Expired" ? "Sign-in expired" : state.label };
  if (account.rateLimited) return { label: "Rate limited, retrying", tone: "warn", needsAction: false } as const;
  if (account.maxAgents != null && (account.runningAgents ?? 0) >= account.maxAgents)
    return { label: "At its limit", tone: "warn", needsAction: false } as const;
  return { ...state, label: "Connected" };
}

/** Custom endpoints declare model IDs, but do not declare a default. Never invent one. */
export function modelsPageModel(account: ModelAccount, harness: Harness): string {
  if (account.models?.length) return "the model you choose at launch";
  return account.kind === "morph" ? MORPH_MODEL_IDS[0] : MODEL_CATALOG[harness].defaultModel;
}

/** A missing personal selection is broken, never silently replaced by another payer. */
export function modelsPageDefault(
  accounts: readonly ModelAccount[],
  harness: Harness,
  now: number,
  defaults?: readonly AgentDefault[],
) {
  const selected = defaults?.find((row) => row.harness === harness);
  if (!selected?.credentialId) return launchDefault(accounts, harness, now);
  const account = accounts.find((row) => row.id === selected.credentialId);
  if (!account || !accountsFor([account], harness).length) {
    return { state: "missing" } as const;
  }
  return { state: isUsable(account, now) ? "resolved" : "unusable", account, why: "personal-default" } as const;
}
