import { expect, test } from "bun:test";
import { nativeHarnessError } from "../src/errors.ts";

test("native classification uses only allowlisted discriminants and RPC phase, never native text", () => {
  expect(nativeHarnessError({ code: -32000 }, "session/load", "acp").reason).toBe(
    "authentication_failed:session_restore",
  );
  expect(nativeHarnessError({ code: -32002 }, "session/load", "acp").reason).toBe(
    "session_restore_failed:session_restore",
  );
  for (const [error, method, code] of [
    [{ code: 401 }, "thread/resume", "authentication_failed"],
    [{ data: { type: "model_not_found" } }, "turn/start", "model_unavailable"],
    [{ code: -32000 }, "session/load", "session_restore_failed"],
    [{ code: -32603 }, "thread/resume", "session_restore_failed"],
    [{}, "session/set_model", "model_selection_failed"],
    [{}, "account/login/start", "authentication_failed"],
    [{}, "session/new", "session_start_failed"],
    [{}, "turn/start", "turn_start_failed"],
    [{}, "initialize", "harness_initialization_failed"],
    [{ code: "cloud_credential_error" }, "assistant", "authentication_failed"],
    [{ code: "overloaded" }, "assistant", "rate_limited"],
    [{ code: "max_output_tokens" }, "assistant", "output_limit_exceeded"],
    [
      { code: "unknown_private_value", message: "unauthorized private_value", data: { message: "private_value" } },
      "unknown",
      "harness_failed",
    ],
  ] as const) {
    const result = nativeHarnessError(error, method);
    expect(result.code).toBe(code);
    expect(result.message).toBe(code);
    if (method === "thread/resume" || method === "session/load") expect(result.reason).toBe(`${code}:session_restore`);
    expect(JSON.stringify(result)).not.toContain("private_value");
  }
});
