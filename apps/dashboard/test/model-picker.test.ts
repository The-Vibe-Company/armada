import { expect, test } from "bun:test";
import { HARNESS_CATALOG } from "@armada/core";
import { connectionModelsFrom } from "../src/lib/model-accounts";
import { chosenConnection, launchArgs } from "../src/lib/model-choice";
import {
  connectionValue,
  decodeModelValue,
  filterPicker,
  modelForAccount,
  pickerGroups,
} from "../src/lib/model-picker";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

test("the picker lists the agent's models with the default marked, then each connection's models grouped", () => {
  const entry = HARNESS_CATALOG.opencode;
  const groups = pickerGroups("OpenCode", entry, [
    {
      accountId: ACCOUNT,
      label: "DeepSeek",
      models: [
        { model: "armada/deepseek-flash", input: "0.15", output: "0.6" },
        { model: "armada/typed", input: null, output: null },
      ],
    },
    { accountId: "22222222-2222-4222-8222-222222222222", label: "Empty", models: [] },
  ]);
  expect(groups.map((group) => group.label)).toEqual(["OpenCode models", "DeepSeek"]);
  expect(groups[0]?.options.filter((option) => option.isDefault).map((option) => option.model)).toEqual([
    entry.defaultModel,
  ]);
  expect(groups[1]?.options).toEqual([
    {
      value: connectionValue(ACCOUNT, "armada/deepseek-flash"),
      model: "armada/deepseek-flash",
      label: "armada/deepseek-flash",
      price: "$0.15 in · $0.6 out per M tokens",
      isDefault: false,
    },
    {
      value: connectionValue(ACCOUNT, "armada/typed"),
      model: "armada/typed",
      label: "armada/typed",
      price: null,
      isDefault: false,
    },
  ]);
  const claude = pickerGroups("Claude Code", HARNESS_CATALOG.claude, []);
  expect(claude[0]?.options.some((option) => option.price !== null)).toBe(true);

  // Search matches the model or the connection name; the current choice is never hidden.
  expect(filterPicker(groups, "armada/typ", "").map((group) => group.label)).toEqual(["DeepSeek"]);
  expect(
    filterPicker(groups, "typed", entry.defaultModel).flatMap((group) => group.options.map((o) => o.model)),
  ).toEqual([entry.defaultModel, "armada/typed"]);
});

test("a connection model sends its bare model ID and names its account for the action's check", () => {
  const value = connectionValue(ACCOUNT, "armada/deepseek-flash");
  expect(decodeModelValue(value)).toEqual({ model: "armada/deepseek-flash", accountId: ACCOUNT });
  expect(decodeModelValue("connection:not-a-uuid:x")).toEqual({ model: "connection:not-a-uuid:x", accountId: null });
  expect(chosenConnection({ model: value })).toBe(ACCOUNT);
  expect(chosenConnection({ model: "gpt-6-sol" })).toBeNull();
  const parsed = launchArgs({
    golden: "g",
    provider: "modal",
    org: "o",
    harness: "opencode",
    prompt: "",
    model: value,
    otherModel: "",
    reasoningEffort: "",
  });
  if (!parsed.ok) throw Error(parsed.error);
  expect(parsed.args.model).toBe("armada/deepseek-flash");
});

test("declared connection models are read strictly: malformed rows and prices are dropped", () => {
  const models = connectionModelsFrom({
    connections: [
      {
        id: ACCOUNT,
        models: [
          { model: "armada/ok", input: "1.5", output: "2" },
          { model: "bad model", input: "1", output: "1" },
          { model: "priced-badly", input: "-1", output: 3 },
        ],
      },
      { id: "nope", models: [{ model: "x" }] },
      { id: "22222222-2222-4222-8222-222222222222", models: [] },
    ],
  });
  expect([...models.entries()]).toEqual([
    [
      ACCOUNT,
      [
        { model: "armada/ok", input: "1.5", output: "2" },
        { model: "priced-badly", input: null, output: null },
      ],
    ],
  ]);
  expect(connectionModelsFrom(null).size).toBe(0);
});

test("changing the account never leaves another connection's model selected", () => {
  const other = "22222222-2222-4222-8222-222222222222";
  const connections = [
    { accountId: ACCOUNT, label: "Foundry", models: [{ model: "team-gpt", input: null, output: null }] },
  ];
  const foundry = connectionValue(ACCOUNT, "team-gpt");
  // To a plain account: back to the agent default. To a connection: its first model, unless one is already chosen.
  expect(modelForAccount(foundry, other, connections, "gpt-6-sol")).toBe("gpt-6-sol");
  expect(modelForAccount("gpt-6-luna", ACCOUNT, connections, "gpt-6-sol")).toBe(foundry);
  expect(modelForAccount(foundry, ACCOUNT, connections, "gpt-6-sol")).toBe(foundry);
  expect(modelForAccount("gpt-6-luna", other, connections, "gpt-6-sol")).toBe("gpt-6-luna");
});
