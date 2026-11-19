import { expect, test } from "bun:test";
import { MODEL_CATALOG } from "@armada/core";
import { initialLaunchSelection, launchPickerGroups } from "./launch-picker";
import type { ModelAccount } from "./model-accounts";

const account: ModelAccount = {
  id: "account_one",
  name: "Claude Max",
  kind: "claude_oauth",
  scope: "user",
  status: "active",
  expiresAt: null,
  updatedAt: "",
  version: 1,
  isDefault: true,
};
test("launch picker retains expired and full accounts with refusal reasons and cross-agent choices", () => {
  const groups = launchPickerGroups(
    [
      { ...account, expiresAt: "2020-01-01T00:00:00Z" },
      {
        ...account,
        id: "account_two",
        kind: "morph",
        maxAgents: 2,
        runningAgents: 2,
        models: [{ model: "morph-custom", input: null, output: null }],
      },
    ],
    MODEL_CATALOG,
    "codex",
    Date.parse("2026-01-01"),
  );
  expect(groups[0]!.reason).toBe("Sign-in expired. Reconnect Claude Max first.");
  expect(groups[0]!.options[0]!.harness).toBe("claude");
  expect(groups[1]!.reason).toContain("2 of 2 agents running. Stop one");
  expect(groups[1]!.options.map((row) => [row.id, row.harness])).toEqual([["morph-custom", "codex"]]);
});

test("a Morph account without model metadata offers no model and initializes no model", () => {
  const morph = { ...account, kind: "morph" } satisfies ModelAccount;
  const now = Date.parse("2026-01-01");
  const [group] = launchPickerGroups([morph], MODEL_CATALOG, "codex", now);
  expect(group?.options).toEqual([]);
  expect(group?.reason).toContain("Reload");
  expect(
    initialLaunchSelection({ state: "ready", accounts: [morph], now, orgName: "Example" }, MODEL_CATALOG, "codex"),
  ).toEqual({ credentialId: morph.id, model: "" });
});
