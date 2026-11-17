import { expect, test } from "bun:test";
import { describeNativeFailure, describeSandboxFailure, promptFailureReason } from "../src/native-failure.ts";

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

test("prompt failure text is bounded and actionable even without a diagnosis", () => {
  expect(promptFailureReason("model_unavailable")).toBe(
    "Model unavailable. Choose a model available to this account, then send the prompt again.",
  );
  expect(promptFailureReason("output_limit_exceeded")).toBe(
    "Model output limit reached. The model stopped before it finished this response. Send a message to continue.",
  );
  expect(promptFailureReason("private upstream details")).toBe(
    "Agent failed. Check the agent configuration before retrying.",
  );
  expect(promptFailureReason()).toBe("Agent failed. Check the agent configuration before retrying.");
});

test("sandbox status reasons use public explanations instead of internal status text", () => {
  expect(
    describeSandboxFailure(
      "Runtime model routing failed. Ask the server operator to check the configured model endpoint before launching again.",
    ).hint,
  ).toContain("model endpoint");
  expect(describeSandboxFailure("expired").title).toBe("Sandbox expired");
  expect(describeSandboxFailure("Armada runtime bootstrap failed.").hint).toContain("could not start");
  expect(describeSandboxFailure("private upstream details")).toEqual({
    title: "Sandbox failed",
    hint: "The sandbox stopped without a public diagnosis. Launch a new sandbox; if it fails again, ask the server operator to inspect its status.",
  });
});
