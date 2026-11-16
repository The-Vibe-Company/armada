import { expect, test } from "bun:test";
import { describeNativeFailure } from "../src/native-failure.ts";

test("public native failures explain bounded categories and phases without accepting upstream text", () => {
  expect(describeNativeFailure("authentication_failed:session_restore")).toEqual({
    title: "Authentication failed",
    hint: "During session restoration. Reconnect the agent account, then send the prompt again.",
  });
  expect(describeNativeFailure("model_unavailable")?.hint).toContain("Choose a model");
  expect(describeNativeFailure("session_restore_failed")?.hint).toContain("new conversation");
  for (const reason of [
    "unknown_private",
    "authentication_failed:private_text",
    "authentication_failed:session_restore:private_text",
    "toString",
  ])
    expect(describeNativeFailure(reason)).toBeNull();
});
