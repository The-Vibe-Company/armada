import { expect, test } from "bun:test";
import { type Provider, ProviderError } from "@armada/core";
import { bootstrapOrchestrator } from "../src/orchestrator-bootstrap.ts";
import { OrchestratorDiagnostics } from "../src/orchestrator-diagnostics.ts";

const reference = "example/notes@1.0.0";
const checksum = `sha256:${"a".repeat(64)}`;
const entry = {
  version: "1.0.0",
  pinned: "1.0.0",
  catalogReference: "example/notes",
  skillId: "11111111-1111-4111-8111-111111111111",
  checksum,
  targets: [{ tool: "codex", version: "1.0.0", packageChecksum: checksum }],
};
const lock = (skill = entry) =>
  JSON.stringify({
    lockfileVersion: 2,
    workspaces: { "catalog:example": { apiUrl: "https://skillpack.app/v1", skills: { notes: skill } } },
  });

// Owns installer receipt validation/order; serve composition owns persistence and first-turn readiness.
test.each([
  "plain",
  "pinned",
  "nonzero",
  "provider error",
  "invalid JSON",
  "detached",
  "truncated",
  "wrong version",
  "wrong checksum",
  "invalid reference",
  "reserved reference",
])("bootstrap %s", async (mode) => {
  const calls: string[] = [];
  const commands: string[] = [];
  const lines: string[] = [];
  const diagnostics = new OrchestratorDiagnostics((line) => lines.push(line), "create");
  diagnostics.stage("skills");
  const provider = {
    exec: async ({ command }: { command: string }) => {
      commands.push(command);
      calls.push("install");
      if (mode === "provider error")
        throw new ProviderError({ provider: "boat", code: "unavailable", message: "private output", retryable: false });
      return {
        detached: mode === "detached",
        timedOut: false,
        truncated: mode === "truncated",
        exitCode: mode === "nonzero" ? 1 : 0,
        stdout:
          mode === "invalid JSON"
            ? "private output"
            : lock(
                mode === "wrong version"
                  ? { ...entry, version: "2.0.0" }
                  : mode === "wrong checksum"
                    ? { ...entry, checksum: "bad" }
                    : entry,
              ),
        stderr: "private output",
      };
    },
  } as unknown as Provider;
  const run = bootstrapOrchestrator(provider, {
    sandboxId: "parent",
    diagnostics,
    projectDir: "/home/user/repo'$(false)",
    skillRevision: "a".repeat(40),
    ...(mode === "plain"
      ? {}
      : {
          skill:
            mode === "invalid reference"
              ? "--evil"
              : mode === "reserved reference"
                ? "example/armada-tools@1.0.0"
                : reference,
        }),
    harness: "codex",
    recordReceipt: async () => {
      calls.push("receipt");
    },
    configureAuthority: async () => {
      calls.push("authority");
    },
  });
  if (mode === "plain" || mode === "pinned") {
    const receipt = await run;
    expect(calls).toEqual(["install", "receipt", "authority"]);
    if (mode === "pinned")
      expect(commands[0]?.split(" && ")[0]).toBe(
        "skillpack install 'example/notes' --version '1.0.0' --api-url https://skillpack.app/v1 --scope project --project '/home/user/repo'\\''$(false)' --tools codex --pin --yes --json >/dev/null",
      );
    expect(receipt).toEqual(
      mode === "plain"
        ? null
        : { reference, version: "1.0.0", skillId: entry.skillId, checksum, origin: "https://skillpack.app/v1" },
    );
  } else {
    await expect(run).rejects.toThrow(
      mode === "invalid reference" || mode === "reserved reference"
        ? "orchestrator_invalid_bootstrap"
        : "orchestrator_skill_bootstrap_failed",
    );
    expect(calls).toEqual(mode === "invalid reference" || mode === "reserved reference" ? [] : ["install"]);
    diagnostics.report("failed");
    const reason =
      mode === "provider error"
        ? "provider_unavailable"
        : ["invalid JSON", "wrong version", "wrong checksum"].includes(mode)
          ? "skill_provenance_missing"
          : mode === "detached"
            ? "skill_execution_detached"
            : mode === "truncated"
              ? "skill_output_truncated"
              : ["invalid reference", "reserved reference"].includes(mode)
                ? "skill_configuration_invalid"
                : "skill_install_nonzero";
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        event: "orchestrator_operation_failure",
        component: "owner",
        action: "create",
        outcome: "failed",
        stage: "skills",
        reason,
      },
    ]);
  }
});

// Real shell boundary: repeated preparation is safe, but unrelated content is never replaced.
test("built-in reference preserves conflicting files", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(`${tmpdir()}/armada-reference-`);
  const provider = {
    exec: async ({ command }: { command: string }) => {
      const child = Bun.spawn(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
      return {
        detached: false,
        timedOut: false,
        truncated: false,
        exitCode: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      };
    },
  } as unknown as Provider;
  const request = {
    sandboxId: "parent",
    projectDir: root,
    skillRevision: "a".repeat(40),
    configureAuthority: async () => {},
  };
  try {
    await bootstrapOrchestrator(provider, request);
    await bootstrapOrchestrator(provider, request);
    const path = `${root}/.agents/skills/armada-tools/SKILL.md`;
    await writeFile(path, "user content");
    await expect(bootstrapOrchestrator(provider, request)).rejects.toThrow("orchestrator_skill_bootstrap_failed");
    expect(await readFile(path, "utf8")).toBe("user content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Missing private auth is rejected before guest commands, receipts or delegated authority.
test.each(["boat", "modal"] as const)("private bootstrap without a key fails closed on %s", async (id) => {
  const calls: string[] = [];
  const diagnostics = new OrchestratorDiagnostics(() => {}, "create");
  diagnostics.stage("skills");
  await expect(
    bootstrapOrchestrator(
      {
        id,
        exec: async () => {
          calls.push("exec");
          throw Error("unexpected");
        },
      } as unknown as Provider,
      {
        sandboxId: "parent",
        projectDir: "/home/user/repo",
        skillRevision: "a".repeat(40),
        skill: "notes@1.0.0",
        diagnostics,
        recordReceipt: async () => {
          calls.push("receipt");
        },
        configureAuthority: async () => {
          calls.push("authority");
        },
      },
    ),
  ).rejects.toThrow("orchestrator_skill_bootstrap_failed");
  expect(calls).toEqual([]);
});
