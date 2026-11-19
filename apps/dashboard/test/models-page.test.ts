import { expect, test } from "bun:test";
import { MODEL_CATALOG } from "@armada/core";
import { initialLaunchSelection, launchPickerGroups } from "../src/lib/launch-picker";
import { accountsFromList, launchAccounts, type ModelAccount } from "../src/lib/model-accounts";
import { modelsPageDefault, modelsPageExhaustion, modelsPageModel, modelsPageStatus } from "../src/lib/models-page";

const account: ModelAccount = {
  id: "account_id",
  name: "Work",
  scope: "user",
  kind: "openai",
  isDefault: true,
  status: "active",
  expiresAt: null,
  updatedAt: "2026-11-01T00:00:00Z",
  version: 1,
  maxAgents: 2,
  runningAgents: 2,
};
test("capacity is distinct from expired authentication, which takes precedence", () => {
  expect(modelsPageStatus({ ...account, rateLimited: true }, 1).label).toBe("Rate limited, retrying");
  expect(modelsPageStatus(account, 1).label).toBe("At its limit");
  expect(modelsPageStatus({ ...account, expiresAt: "2026-11-01T00:00:00Z" }, Date.parse("2026-11-15")).label).toBe(
    "Sign-in expired",
  );
  expect(modelsPageStatus({ ...account, maxAgents: null }, 1).label).toBe("Connected");
});
test("Models shows the API exhaustion deadline until the reset", () => {
  const exhaustedUntil = "2026-11-19T14:00:00.000Z";
  const reset = Date.parse(exhaustedUntil);
  const { accounts } = accountsFromList(
    { user: [{ ...account, id: "00000000-0000-0000-0000-000000000001", exhaustedUntil }] },
    "org",
  );
  const listed = accounts[0]!;
  expect(modelsPageExhaustion(listed, reset - 1)).toBe("Exhausted until 2026-11-19 14:00 UTC");
  expect(modelsPageStatus(listed, reset - 1).label).toBe("At its limit");
  expect(modelsPageExhaustion(listed, reset)).toBeNull();
});
test("custom endpoint models are not mistaken for a saved default", () => {
  expect(modelsPageModel({ ...account, models: [{ model: "deployment", input: null, output: null }] }, "codex")).toBe(
    "the model you choose at launch",
  );
  expect(modelsPageModel(account, "codex")).toBe("gpt-6.2-sol");
});

test("the Morph account summary shows its first saved model as the default", () => {
  const morph = {
    ...account,
    kind: "morph" as const,
    models: [{ model: "owner/model-v2", input: null, output: null }],
  };
  expect(modelsPageModel(morph, "opencode")).toBe("owner/model-v2");
  expect(modelsPageModel({ ...morph, models: undefined }, "opencode")).toBe("Model list unavailable");
});

test("personal per-agent accounts override account-wide defaults without billing fallback", () => {
  const shared = { ...account, id: "shared_account", kind: "morph" as const, isDefault: false, maxAgents: null };
  const defaults = [{ harness: "codex" as const, credentialId: shared.id, model: "morph-kimik31" }];
  expect(modelsPageDefault([account, shared], "codex", 1, defaults)).toMatchObject({
    state: "resolved",
    account: { id: shared.id },
  });
  expect(modelsPageDefault([account], "codex", 1, defaults)).toEqual({ state: "missing" });
  expect(
    modelsPageDefault([account], "codex", 1, [{ harness: "claude", credentialId: shared.id, model: null }]),
  ).toMatchObject({ state: "resolved", account: { id: account.id } });
});

test("launch initialization carries personal agent choices through the account projection", () => {
  const shared = {
    ...account,
    id: "shared_account",
    kind: "morph" as const,
    isDefault: false,
    maxAgents: null,
    models: ["morph-kimik31", "morph-dsv41flash"].map((model) => ({ model, input: null, output: null })),
  };
  const defaults = [
    { harness: "codex" as const, credentialId: shared.id, model: "morph-dsv41flash" },
    { harness: "claude" as const, credentialId: shared.id, model: "morph-kimik31" },
  ];
  const list = launchAccounts(
    { state: "ready", accounts: [account, shared], orgId: "org", orgName: "Work", defaults },
    1,
  );
  expect(initialLaunchSelection(list, MODEL_CATALOG, "codex")).toEqual({
    credentialId: shared.id,
    model: "morph-dsv41flash",
  });
  expect(initialLaunchSelection(list, MODEL_CATALOG, "claude")).toEqual({
    credentialId: shared.id,
    model: "morph-kimik31",
  });
  const missing = launchAccounts({ state: "ready", accounts: [account], orgId: "org", orgName: "Work", defaults }, 1);
  expect(initialLaunchSelection(missing, MODEL_CATALOG, "codex").credentialId).toBe("");
});

test("OpenAI key and subscription accounts offer GPT-6.2 and select GPT-6.2 Sol by default", () => {
  for (const kind of ["openai", "codex_auth"] as const) {
    const list = launchAccounts(
      { state: "ready", accounts: [{ ...account, kind, maxAgents: null }], orgId: "org", orgName: "Work" },
      1,
    );
    expect(launchPickerGroups(list.accounts, MODEL_CATALOG, "codex", 1)[0]?.options.map((model) => model.id)).toEqual(
      expect.arrayContaining(["gpt-6.2-sol", "gpt-6.2-astra"]),
    );
    expect(initialLaunchSelection(list, MODEL_CATALOG, "codex").model).toBe("gpt-6.2-sol");
  }
});
