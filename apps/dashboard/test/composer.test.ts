import { describe, expect, test } from "bun:test";
import { chosenConversation, dockerSend, modelChange, PINNED_MODEL, plainSendFailure } from "../src/lib/composer.ts";

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

  test("a Docker send carries its request key and no model; field names never reach the person", () => {
    const key = "0b9f3c1e-7d2a-4c5b-9e8f-1a2b3c4d5e6f";
    expect(dockerSend(fields(), key)).toEqual({ ok: true, requestId: key });
    expect(dockerSend(fields("", "", "high"), key)).toEqual({ ok: false, error: PINNED_MODEL });
    expect(dockerSend(fields(), "")).toMatchObject({ ok: false });
    expect(dockerSend(fields(), key.toUpperCase())).toMatchObject({ ok: false });
    expect(plainSendFailure("Docker send requires request_id and prompt; model and effort remain pinned.")).toBe(
      "The message could not be delivered. Send it again.",
    );
    expect(plainSendFailure("Docker sandbox must be running before send.")).toBe(
      "Docker sandbox must be running before send.",
    );
  });
});
