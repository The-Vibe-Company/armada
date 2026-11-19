import type { Harness } from "./contract.ts";
import { MODEL_CATALOG } from "./models.ts";

export interface AccountPool {
  harness: Harness;
  credentialIds: readonly string[];
  model?: string | null | undefined;
}

export interface AccountCandidate {
  version: number;
  status: string;
  expiresAt?: string | null | undefined;
  harnesses: readonly Harness[];
  models?: readonly string[];
  exhaustion?: { version: number; code: string; resetsAt: string | null };
  budget?: { capUsd: number; spentUsd: number; modelPriceKnown: boolean; hasUnpricedUsage: boolean };
  capacity?: "account_full" | "model_full";
}

export type AccountRefusal =
  | {
      code:
        | "account_unavailable"
        | "account_inactive"
        | "account_expired"
        | "account_version_changed"
        | "incompatible_harness"
        | "incompatible_model"
        | "pricing_unknown"
        | "account_full"
        | "model_full";
    }
  | { code: "account_exhausted"; exhaustionCode: string; resetsAt: string }
  | { code: "budget_exhausted"; resetsAt: string };

export interface AccountSkip {
  credentialId: string;
  reason: AccountRefusal;
}

export type AccountChoice = { model: string; skips: AccountSkip[] } & (
  | { kind: "account"; credentialId: string; credentialVersion: number }
  | { kind: "wait" | "refuse" }
);

export interface AccountPoolFacts {
  now: number;
  candidates: ReadonlyMap<string, AccountCandidate>;
  explicit?: { credentialId: string; credentialVersion?: number };
  canWait?: boolean;
}

export const choose: (pool: AccountPool, requestedModel: string | undefined, facts: AccountPoolFacts) => AccountChoice =
  (pool, requestedModel, facts) => {
    const model =
      requestedModel ?? (facts.explicit ? undefined : pool.model) ?? MODEL_CATALOG[pool.harness].defaultModel;
    const ids = facts.explicit ? [facts.explicit.credentialId] : pool.credentialIds;
    const skips: AccountSkip[] = [];
    for (const credentialId of ids) {
      const candidate = facts.candidates.get(credentialId);
      if (!candidate) {
        skips.push({ credentialId, reason: { code: "account_unavailable" } });
        continue;
      }
      const reason = accountIneligibility(candidate, pool.harness, facts.now, facts.explicit?.credentialVersion, model);
      if (!reason) return { kind: "account", credentialId, credentialVersion: candidate.version, model, skips };
      skips.push({ credentialId, reason });
    }
    const capacityOnly =
      skips.length > 0 && skips.every(({ reason }) => reason.code === "account_full" || reason.code === "model_full");
    return { kind: facts.canWait && capacityOnly ? "wait" : "refuse", model, skips };
  };

export const accountIneligibility: (
  candidate: AccountCandidate,
  harness: Harness,
  now: number,
  version?: number,
  model?: string,
) => AccountRefusal | undefined = (candidate, harness, now, version, model) => {
  if (!candidate.harnesses.includes(harness)) return { code: "incompatible_harness" };
  if (candidate.status !== "active") return { code: "account_inactive" };
  if (candidate.expiresAt && Date.parse(candidate.expiresAt) <= now) return { code: "account_expired" };
  if (version !== undefined && candidate.version !== version) return { code: "account_version_changed" };
  if (model !== undefined && candidate.models && !candidate.models.includes(model))
    return { code: "incompatible_model" };

  const exhaustion = candidate.exhaustion;
  if (exhaustion?.version === candidate.version && exhaustion.resetsAt && Date.parse(exhaustion.resetsAt) > now) {
    return { code: "account_exhausted", exhaustionCode: exhaustion.code, resetsAt: exhaustion.resetsAt };
  }

  const budget = candidate.budget;
  if (budget) {
    if (budget.spentUsd >= budget.capUsd) {
      const reset = new Date(now);
      reset.setUTCMonth(reset.getUTCMonth() + 1, 1);
      reset.setUTCHours(0, 0, 0, 0);
      return { code: "budget_exhausted", resetsAt: reset.toISOString() };
    }
    if (!budget.modelPriceKnown || budget.hasUnpricedUsage) return { code: "pricing_unknown" };
  }
  if (candidate.capacity) return { code: candidate.capacity };
};
