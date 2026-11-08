import { expect, test } from "bun:test";
import type { ExecRequest, ExecResult, Provider } from "../src/index.ts";
import { scanGoldenSandbox } from "../src/index.ts";

function provider(result: Partial<ExecResult>, calls: ExecRequest[]): Provider {
  return {
    exec: async (request: ExecRequest) => {
      calls.push(request);
      return { detached: false, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...result };
    },
  } as unknown as Provider;
}

test("passes when nothing token-shaped is on disk", async () => {
  const calls: ExecRequest[] = [];
  await scanGoldenSandbox(provider({ exitCode: 0 }, calls), "bx_1");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.sandboxId).toBe("bx_1");
  expect(calls[0]?.command).toContain("gh[suo]_");
  expect(calls[0]?.command).toContain("log --all -p");
});

test("a leaked token fails closed without the match ever appearing in the error", async () => {
  const calls: ExecRequest[] = [];
  await expect(scanGoldenSandbox(provider({ exitCode: 97 }, calls), "bx_1")).rejects.toThrow("token-shaped material");
});

test("a timeout and a background command both stop the build", async () => {
  const calls: ExecRequest[] = [];
  await expect(scanGoldenSandbox(provider({ timedOut: true }, calls), "bx_1")).rejects.toThrow("timed out");
  await expect(
    scanGoldenSandbox({ exec: async () => ({ detached: true, processId: 1 }) } as unknown as Provider, "bx_1"),
  ).rejects.toThrow("background");
});
