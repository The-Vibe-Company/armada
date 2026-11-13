import { describe, expect, test } from "bun:test";
import {
  chosenConversation,
  messageKeyFor,
  modelChange,
  PINNED_MODEL,
  pinnedSend,
  plainSendFailure,
} from "../src/lib/composer.ts";

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
    expect(pinnedSend(fields(), key)).toEqual({ ok: true, requestId: key });
    expect(pinnedSend(fields("", "", "high"), key)).toEqual({ ok: false, error: PINNED_MODEL });
    expect(pinnedSend(fields(), "")).toMatchObject({ ok: false });
    expect(pinnedSend(fields(), key.toUpperCase())).toMatchObject({ ok: false });
  });

  test("send errors distinguish unconfirmed work and keep unchanged-input guidance", () => {
    expect(plainSendFailure("Docker send requires request_id and prompt; model and effort remain pinned.")).toBe(
      "The message could not be delivered. Send it again.",
    );
    for (const message of [
      "Docker prompt admission pending. Retry identical input with the same request_id.",
      "Runtime send outcome is uncertain; reuse the original request_id and identical input.",
      "Resume outcome unknown; inspect status with the same request_id.",
    ])
      expect(plainSendFailure(message)).toBe(
        "The message has not been confirmed and may still run. Keep it unchanged and check the sandbox status before retrying.",
      );
    expect(plainSendFailure("Docker sandbox must be running before send.")).toBe(
      "Docker sandbox must be running before send.",
    );
  });
});

test("ordinary message keys survive unchanged retries and rotate for any submitted choice", () => {
  const fields = ["sandbox", "prompt", "conversation", "model", "other_model", "reasoning_effort"];
  const data = new FormData();
  for (const name of fields) data.set(name, `${name}-original`);
  let serial = 0;
  const fresh = () => `key-${++serial}`;
  const first = messageKeyFor(null, data, fresh);
  expect(messageKeyFor(first, data, fresh)).toEqual(first);
  for (const name of fields) {
    const changed = new FormData();
    for (const [field, value] of data) changed.set(field, value);
    changed.set(name, "changed");
    expect(messageKeyFor(first, changed, fresh).key).not.toBe(first.key);
  }
});
