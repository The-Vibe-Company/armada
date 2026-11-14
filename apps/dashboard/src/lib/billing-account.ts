import type { CredentialKind } from "@armada/core";
import { ACCOUNT_KINDS, KIND_INFO } from "./model-accounts";

export type BillingAccountMetadata = { id: string; name: string; kind: CredentialKind };
export type BillingAccount = {
  name: string;
  billing: "Subscription" | "API key" | "Unknown";
  kindLabel: string | null;
};

/** Display only the pinned account: unreadable metadata never substitutes today's default or another account. */
export function billingAccount(
  credentialId: string | null,
  accounts: ReadonlyMap<string, BillingAccountMetadata>,
): BillingAccount {
  if (!credentialId) return { name: "No account selected", billing: "Unknown", kindLabel: null };
  const account = accounts.get(credentialId);
  if (!account) return { name: "Unavailable", billing: "Unknown", kindLabel: null };
  const kind = ACCOUNT_KINDS.find((kind) => kind === account.kind);
  return {
    name: account.name,
    kindLabel: kind ? KIND_INFO[kind].label : null,
    billing: kind ? (KIND_INFO[kind].billing === "subscription" ? "Subscription" : "API key") : "Unknown",
  };
}
