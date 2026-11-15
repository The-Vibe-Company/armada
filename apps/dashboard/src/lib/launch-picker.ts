import { COMPATIBLE_MODEL_PROVIDERS, type Harness, harnessesForCredential } from "@armada/core";
import type { ModelCatalog } from "@/components/model-fields";
import { accountProblem, type ModelAccount } from "@/lib/model-accounts";

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
