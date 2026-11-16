import { expect, test } from "bun:test";
import type { ExecRequest, Provider } from "../src/server.ts";
import { scanGoldenSandbox } from "../src/server.ts";
import { capturedScript, provider } from "./golden-scan-fixture.ts";

test("execs one bounded, foreground command in the sandbox", async () => {
  const calls: ExecRequest[] = [];
  await scanGoldenSandbox(provider({ exitCode: 0 }, calls), "bx_1");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.sandboxId).toBe("bx_1");
  expect(calls[0]?.command).toContain("gh[oprsu]_");
  expect(calls[0]?.command).toContain("cat-file --batch-all-objects");
  expect(calls[0]?.timeoutSeconds).toBeGreaterThan(0);
});

test("uses non-interactive sudo for the production scan command", async () => {
  const script = await capturedScript();
  expect(script).toContain("id -u");
  expect(script).toContain("sudo -n bash -c");
  expect(script).toContain("else exec sudo");
});

test("a leaked token fails closed without the match ever appearing in the error", async () => {
  const calls: ExecRequest[] = [];
  await expect(scanGoldenSandbox(provider({ exitCode: 97 }, calls), "bx_1")).rejects.toThrow("token-shaped material");
});

test("any other failure (the scan itself could not run) also stops the build, distinctly from a hit", async () => {
  const calls: ExecRequest[] = [];
  await expect(scanGoldenSandbox(provider({ exitCode: 95 }, calls), "bx_1")).rejects.toThrow("could not run");
});

test("a timeout and a background command both stop the build", async () => {
  const calls: ExecRequest[] = [];
  await expect(scanGoldenSandbox(provider({ timedOut: true }, calls), "bx_1")).rejects.toThrow("timed out");
  await expect(
    scanGoldenSandbox({ exec: async () => ({ detached: true, processId: 1 }) } as unknown as Provider, "bx_1"),
  ).rejects.toThrow("background");
});

test.each([
  ["1 git_object " + "a".repeat(40) + " " + "b".repeat(40), "repository armada, git object"],
  ["1 file_content - -", "repository armada, file content"],
  ["1 path_name - -", "repository armada, path name"],
  ["0 file_content - -", "outside configured repositories"],
  ["17 file_content - -", "on disk"],
  ["2 file_content - -", "on disk"],
  ["1 git_object opaque-value -", "on disk"],
  ["1 git_object " + "a".repeat(40) + " opaque-value", "on disk"],
])("scan failure accepts only bounded location metadata (%s)", async (record, expected) => {
  const calls: ExecRequest[] = [];
  let error: unknown;
  try {
    await scanGoldenSandbox(
      provider({ exitCode: 97, stdout: "ARMADA_SCAN_LOCATION " + record + "\nopaque-value" }, calls),
      "builder",
      { repositories: ["armada"] },
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: "setup_failed", safeMessage: expect.stringContaining(expected) });
  expect(String(error)).not.toContain("opaque-value");
});

test("a token-shaped repository name is not eligible for public scan diagnostics", async () => {
  const token = "ghp_" + "Z".repeat(36);
  const calls: ExecRequest[] = [];
  await expect(scanGoldenSandbox(provider({}, calls), "builder", { repositories: [token] })).rejects.toThrow(
    "Invalid repository directory",
  );
  expect(calls).toEqual([]);
});
