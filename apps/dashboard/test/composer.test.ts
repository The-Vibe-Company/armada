import { describe, expect, test } from "bun:test";
import { chosenConversation, modelChange } from "../src/lib/composer.ts";

const fields = (model = "", otherModel = "", reasoningEffort = "") => ({ model, otherModel, reasoningEffort });

describe("composer guards", () => {
  test("only a conversation recorded for the sandbox can be targeted; none lets the server choose", () => {
    expect(chosenConversation("conv-b", ["conv-a", "conv-b"])).toEqual({ ok: true, id: "conv-b" });
    expect(chosenConversation(" ", ["conv-a"])).toEqual({ ok: true, id: undefined });
    expect(chosenConversation("conv-x", ["conv-a"])).toMatchObject({ ok: false });
  });

  test("a model or effort choice is a change a steer refuses; an empty other model id is never the launch model", () => {
    expect(modelChange(fields())).toBe("none");
    expect(modelChange(fields("", "", "high"))).toBe("changed");
    expect(modelChange(fields("gpt-6-luna"))).toBe("changed");
    expect(modelChange(fields("other", "my-model"))).toBe("changed");
    expect(modelChange(fields("other", "  "))).toBe("incomplete");
  });
});
