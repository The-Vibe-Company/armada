import { expect, test } from "bun:test";
import type { CredentialKind } from "@armada/core";
import { type BillingAccountMetadata, billingAccount } from "@/lib/billing-account";

test.each<[CredentialKind, string]>([
  ["claude_oauth", "Subscription"],
  ["codex_auth", "Subscription"],
  ["anthropic", "API key"],
  ["openai", "API key"],
  ["opencode", "API key"],
])("the pinned %s account shows its name and billing type", (kind, billing) => {
  const accounts = new Map<string, BillingAccountMetadata>([
    ["pinned", { id: "pinned", name: "Work account", kind }],
    ["other", { id: "other", name: "Personal default", kind: "codex_auth" }],
  ]);
  expect(billingAccount("pinned", accounts)).toEqual({ name: "Work account", billing });
});

test("private or missing pinned metadata stays unavailable, never another readable account", () => {
  const accounts = new Map<string, BillingAccountMetadata>([
    ["other", { id: "other", name: "Personal default", kind: "codex_auth" }],
  ]);
  expect(billingAccount("private", accounts)).toEqual({ name: "Unavailable", billing: "Unknown" });
  expect(billingAccount(null, accounts)).toEqual({ name: "Not bound", billing: "Unknown" });
});
