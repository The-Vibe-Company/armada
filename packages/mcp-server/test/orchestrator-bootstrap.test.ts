import { describe, expect, test } from "bun:test";
import type { Provider } from "@armada/core";
import { bootstrapOrchestrator } from "../src/orchestrator-bootstrap.ts";

const revision = "78884de87066851b75e09cbda134606c0a8bc6d7";
const source = `https://github.com/The-Vibe-Company/armada/tree/${revision}/.agents/skills`;

function fixture(stdout = `Source: ${source}\n`, exitCode = 0) {
  const commands: string[] = [];
  const provider = {
    exec: async ({ command }: { command: string }) => {
      commands.push(command);
      return {
        detached: false as const,
        exitCode,
        stdout,
        stderr: "private diagnostic",
        timedOut: false,
        truncated: false,
      };
    },
  } as unknown as Provider;
  return { commands, provider };
}

describe("orchestrator bootstrap", () => {
  test("installs pinned public skills before private authority, with literal shell arguments", async () => {
    const { provider, commands } = fixture();
    let configured = false;
    const receipt = await bootstrapOrchestrator(provider, {
      sandboxId: "parent",
      projectDir: "/home/user/repo'$(false)",
      skillRevision: revision,
      configureAuthority: async () => {
        expect(commands).toHaveLength(1);
        configured = true;
      },
    });
    expect(configured).toBe(true);
    expect(commands[0]).toContain(`--revision '${revision}'`);
    expect(commands[0]).toContain("--project '/home/user/repo'\\''$(false)'");
    expect(receipt).toEqual({ revision, source });
  });

  test.each([
    ["conflicting destination", `Source: ${source}\n`, 1],
    ["missing provenance", "Installed: directory\n", 0],
    ["different revision", `Source: ${source.replace(revision, "a".repeat(40))}\n`, 0],
  ])("%s blocks authority and does not expose guest output", async (_name, stdout, exitCode) => {
    const { provider } = fixture(stdout, exitCode);
    let configured = false;
    await expect(
      bootstrapOrchestrator(provider, {
        sandboxId: "parent",
        projectDir: "/home/user/repo",
        skillRevision: revision,
        configureAuthority: async () => {
          configured = true;
        },
      }),
    ).rejects.toThrow("orchestrator_skill_bootstrap_failed");
    expect(configured).toBe(false);
  });

  test.each(["main", "a".repeat(39), "A".repeat(40)])(
    "refuses unpinned revision %s before guest I/O",
    async (skillRevision) => {
      const { provider, commands } = fixture();
      await expect(
        bootstrapOrchestrator(provider, {
          sandboxId: "parent",
          projectDir: "/home/user/repo",
          skillRevision,
          configureAuthority: async () => {},
        }),
      ).rejects.toThrow("orchestrator_invalid_bootstrap");
      expect(commands).toHaveLength(0);
    },
  );
});
