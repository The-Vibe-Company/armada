import { expect, test } from "bun:test";
import type { CredentialKind } from "@armada/core";
import { type BillingAccountMetadata, billingAccount } from "@/lib/billing-account";

test.each<[CredentialKind, string, string]>([
  ["claude_oauth", "Subscription", "Claude subscription"],
  ["codex_auth", "Subscription", "ChatGPT subscription"],
  ["anthropic", "API key", "Anthropic API key"],
  ["openai", "API key", "OpenAI API key"],
  ["opencode", "API key", "OpenCode API key"],
])("the pinned %s account shows its name and billing type", (kind, billing, kindLabel) => {
  const accounts = new Map<string, BillingAccountMetadata>([
    ["pinned", { id: "pinned", name: "Work account", kind }],
    ["other", { id: "other", name: "Personal default", kind: "codex_auth" }],
  ]);
  expect(billingAccount("pinned", accounts)).toEqual({ name: "Work account", billing, kindLabel });
});

test("private or missing pinned metadata stays unavailable, never another readable account", () => {
  const accounts = new Map<string, BillingAccountMetadata>([
    ["other", { id: "other", name: "Personal default", kind: "codex_auth" }],
  ]);
  expect(billingAccount("private", accounts)).toEqual({ name: "Unavailable", billing: "Unknown", kindLabel: null });
  expect(billingAccount(null, accounts)).toEqual({ name: "No account selected", billing: "Unknown", kindLabel: null });
});
