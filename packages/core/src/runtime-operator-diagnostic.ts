import { describeNativeFailure } from "./native-failure.ts";
import { type FailureDiagnostic, failureDiagnostic } from "./operator-failure.ts";

const classes: ReadonlySet<string> = new Set([
  "Error",
  "HarnessError",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
  "SystemError",
]);
const sourceLocation =
  /^(?:runtime|main|codex|claude|opencode|acp|dialout|artifact-cache|harness-cache|enrolled-harness|native-auth|exec-env|state|journal)\.ts:[1-9]\d{0,5}:[1-9]\d{0,4}$/;
const bundledLocation = /^(?:main\.js|armada-runtime):[1-9]\d{0,6}:[1-9]\d{0,6}$/;
const isSourceLocation = (frame: string) => sourceLocation.test(frame) || bundledLocation.test(frame);
const runnerReasons: ReadonlySet<string> = new Set([
  "harness_process_lost",
  "harness_timeout",
  "invalid_harness_protocol",
]);

export interface RuntimeOperatorDiagnostic {
  errorClass: string;
  stack: string[];
  reason?: string;
}

function isHarnessReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 96 &&
    (runnerReasons.has(value) || describeNativeFailure(value) !== null)
  );
}

/** An enrolled runtime can report bounded diagnostic facts. Never send guest exception text or paths. */
export function runtimeOperatorDiagnostic(error: unknown, reason?: string): RuntimeOperatorDiagnostic {
  const { errorClass, stack }: FailureDiagnostic = failureDiagnostic(error);
  return {
    errorClass: reason !== undefined ? "HarnessError" : classes.has(errorClass) ? errorClass : "Error",
    stack: stack.filter((frame) => isSourceLocation(frame)).slice(0, 4),
    ...(isHarnessReason(reason) ? { reason } : {}),
  };
}

/** The authenticated runtime remains untrusted as a source of log content. */
export function isRuntimeOperatorDiagnostic(value: unknown): value is RuntimeOperatorDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { errorClass, stack, reason, ...extra } = value as Record<string, unknown>;
  return (
    Object.keys(extra).length === 0 &&
    typeof errorClass === "string" &&
    classes.has(errorClass) &&
    Array.isArray(stack) &&
    stack.length <= 4 &&
    stack.every((frame) => typeof frame === "string" && isSourceLocation(frame)) &&
    (reason === undefined || isHarnessReason(reason))
  );
}
