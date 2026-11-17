import { expect, test } from "bun:test";
import { acpStopReasonCode } from "../src/errors.ts";

test("ACP stop reasons name the model output limit instead of a configuration failure", () => {
  expect(acpStopReasonCode("end_turn")).toBe("finished");
  expect(acpStopReasonCode("cancelled")).toBe("interrupted");
  expect(acpStopReasonCode("max_tokens")).toBe("output_limit_exceeded");
  // Unknown or malformed reasons stay generic and never echo native text.
  expect(acpStopReasonCode("refusal")).toBe("harness_failed");
  expect(acpStopReasonCode(undefined)).toBe("harness_failed");
  expect(acpStopReasonCode({ private: "value" })).toBe("harness_failed");
});
