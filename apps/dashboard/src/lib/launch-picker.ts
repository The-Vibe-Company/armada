import { COMPATIBLE_MODEL_PROVIDERS, type Harness, harnessesForCredential } from "@armada/core";
import type { ModelCatalog } from "@/components/model-fields";
import { accountProblem, type LaunchAccounts, type ModelAccount } from "@/lib/model-accounts";
import { modelsPageDefault } from "@/lib/models-page";

/** Keep unusable accounts in the picker: refusing selection must never hide the explanation. */
export function launchPickerGroups(
  accounts: readonly ModelAccount[],
  catalog: ModelCatalog,
  current: Harness,
  now: number,
) {
  return accounts.map((account) => {
    const problem = accountProblem(account, now);
    const reason =
      problem === "expired"
        ? `Sign-in expired. Reconnect ${account.name} first.`
        : problem
          ? `${account.name} is ${problem}. Repair this account first.`
          : account.maxAgents != null && (account.runningAgents ?? 0) >= account.maxAgents
            ? `${account.runningAgents} of ${account.maxAgents} agents running. Stop one, or raise the limit, to launch here.`
            : null;
    const agents = harnessesForCredential(account.kind);
    // Shared accounts offer the current agent once, not three identical sets of model ids.
    const harness = agents.includes(current) ? current : (agents[0] ?? current);
    const entry = catalog[harness];
    const options = account.models?.length
      ? account.models.map((row) => ({ id: row.model, label: row.model, harness, isDefault: false }))
      : account.kind === "morph"
        ? COMPATIBLE_MODEL_PROVIDERS.morph.models.map((id) => ({ id, label: id, harness, isDefault: false }))
        : entry.models.map((row) => ({ ...row, harness, isDefault: row.id === entry.defaultModel }));
    return { account, reason, options };
  });
}

/** Initial selection only: later explicit picker choices must never be overwritten. */
export function initialLaunchSelection(accounts: LaunchAccounts, catalog: ModelCatalog, harness: Harness) {
  const resolved =
    accounts.state === "ready" ? modelsPageDefault(accounts.accounts, harness, accounts.now, accounts.defaults) : null;
  const account = resolved?.state === "resolved" ? resolved.account : undefined;
  const preference = accounts.state === "ready" ? accounts.defaults?.find((row) => row.harness === harness) : undefined;
  const savedModel =
    preference && (!preference.credentialId || preference.credentialId === account?.id) ? preference.model : null;
  return {
    credentialId: account?.id ?? "",
    model:
      savedModel ??
      account?.models?.[0]?.model ??
      (account?.kind === "morph" ? COMPATIBLE_MODEL_PROVIDERS.morph.models[0]! : catalog[harness].defaultModel),
  };
}

/** A visible launch source. Refused entries stay in the picker with their recovery instruction. */
export type LaunchStartTarget = {
  id: string;
  label: string;
  group: string;
  reason?: string;
  golden: string;
  provider: import("@armada/core").SandboxPlacementProviderId;
  snapshotId?: string;
  snapshotRef?: string;
  hostId?: string;
  /** The Docker host name shown on the launch form; the group label is display text only. */
  hostName?: string;
  repositories: readonly { url: string; dir: string }[];
  createdAt?: string;
  sourceId?: string;
  building?: boolean;
  failed?: boolean;
  sizing?: { policy: import("@armada/core").MachineSizePolicy | null };
  harnesses?: import("@armada/core").Harness[];
  initialHarness?: import("@armada/core").Harness;
};
