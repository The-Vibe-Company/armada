import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { type ExecResult, ProviderError } from "../src/provider.ts";
import { preserveWork, workPreservationError } from "../src/work-preservation.ts";

let expire: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout>;
let cleared: unknown[];
const restore: (() => void)[] = [];
beforeEach(() => {
  expire = undefined;
  timer = Symbol("capture-deadline") as unknown as ReturnType<typeof setTimeout>;
  cleared = [];
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    expire = callback;
    return timer;
  }) as typeof setTimeout);
  restore.push(() => timeout.mockRestore());
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation((value) => {
    cleared.push(value);
  });
  restore.push(() => clear.mockRestore());
});
afterEach(() => {
  for (const cleanup of restore.splice(0).reverse()) cleanup();
});

test("an unresponsive provider is bounded and late output cannot become success", async () => {
  const pending = Promise.withResolvers<ExecResult>();
  let signal: AbortSignal | undefined;
  const result = preserveWork(
    {
      exec: (request) => {
        signal = request.signal;
        return pending.promise;
      },
    },
    "sandbox",
  );
  if (!expire) throw new Error("Capture deadline was not installed");
  expire();
  const expected = {
    status: "failed",
    reason: "timeout",
    diagnostic: { stage: "collect_exec", errorClass: "timeout", providerStatus: null },
  } as const;
  expect(await result).toEqual(expected);
  expect(signal?.aborted).toBe(true);
  expect(cleared).toEqual([timer]);
  pending.resolve({
    detached: false,
    exitCode: 0,
    stdout: '{"status":"clean"}',
    stderr: "",
    timedOut: false,
    truncated: false,
  });
  await Promise.resolve();
  expect(await result).toEqual(expected);
});

const providerError = new ProviderError({
  provider: "boat",
  code: "unavailable",
  status: 502,
  retryable: true,
  message: "PRIVATE_MESSAGE",
  providerCode: "PRIVATE_CODE",
  details: { secret: "PRIVATE_BODY" },
});

test.each([
  ["unexpected", new Error("PRIVATE_MESSAGE"), "unexpected", null],
  ["provider", providerError, "provider_unavailable", 502],
  [
    "invalid provider metadata",
    Object.assign(new ProviderError({ provider: "boat", code: "unknown", retryable: false, message: "PRIVATE" }), {
      code: "PRIVATE_CODE",
      status: 9000,
    }),
    "provider_unknown",
    null,
  ],
  ["deadline", Object.assign(new Error("PRIVATE_MESSAGE"), { name: "TimeoutError" }), "timeout", null],
] as const)(
  "collector error classification excludes private provider fields (%s)",
  (_name, error, errorClass, providerStatus) => {
    expect(workPreservationError(error)).toEqual({ errorClass, providerStatus });
  },
);

test("collector API carries the closed error classification and owning execution stage", async () => {
  expect(
    await preserveWork(
      {
        exec: async () => {
          throw providerError;
        },
      },
      "sandbox",
    ),
  ).toEqual({
    status: "failed",
    reason: "exec_failed",
    diagnostic: { stage: "collect_exec", errorClass: "provider_unavailable", providerStatus: 502 },
  });
});

test.each([
  ["nonzero exit", { exitCode: 127 }, "collector_exit"],
  ["signal exit", { exitCode: 137 }, "collector_signal"],
  ["truncated", { truncated: true }, "output_truncated"],
  ["timed out", { timedOut: true }, "timeout"],
  ["invalid JSON", { stdout: "private invalid output" }, "output_invalid"],
  ["untrusted reason", { stdout: '{"status":"failed","reason":"private data"}' }, "output_invalid"],
  ...(["missing_git", "missing_bun", "missing_openssl", "size_limit", "timeout"] as const).map(
    (reason) => [reason, { stdout: JSON.stringify({ status: "failed", reason }) }, reason] as const,
  ),
] as const)("collector output preserves only the closed receipt reason (%s)", async (_name, output, expected) => {
  expect(
    await preserveWork(
      {
        async exec() {
          return Object.assign(
            {
              detached: false as const,
              exitCode: 0,
              stdout: "",
              stderr: "private error",
              timedOut: false,
              truncated: false,
            },
            output,
          );
        },
      },
      "sandbox",
    ),
  ).toEqual({
    status: "failed",
    reason: expected,
    ...("timedOut" in output && output.timedOut
      ? { diagnostic: { stage: "collect_exec", errorClass: "timeout", providerStatus: null } }
      : {}),
  });
});
