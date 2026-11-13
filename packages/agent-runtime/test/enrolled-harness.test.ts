import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareEnrolledHarness } from "../src/enrolled-harness.ts";

// Owning boundary is bootstrap wiring: installer integrity already belongs to
// harness-cache.test.ts. This checks server selection -> driver executable/env.
test.each(["codex", "claude"] as const)(
  "enrolled bootstrap selects %s verified CLI and scopes PATH without mutating credential configuration",
  async (harness) => {
    const root = await mkdtemp(join(tmpdir(), "enrolled-harness-"));
    try {
      const contents = new TextEncoder().encode("selected fixture executable"),
        archive = await new Bun.Archive({ [`bin/${harness}`]: contents }).bytes(),
        hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
      const configuration = {
        root,
        selectedHarness: harness,
        artifactManifest: {
          protocol: 1,
          platform: "linux",
          architecture: process.arch,
          libc: "glibc",
          harnesses: {
            [harness]: {
              version: "fixture",
              archive: { bytes: archive.length, sha256: hash(archive) },
              executable: `bin/${harness}`,
              files: [{ path: `bin/${harness}`, bytes: contents.length, sha256: hash(contents), executable: true }],
            },
          },
        },
        claudeEnv: { PATH: "/fixture/tools", ANTHROPIC_API_KEY: "synthetic-claude-material" },
        codexEnv: { PATH: "/fixture/tools", OPENAI_API_KEY: "synthetic-model-material" },
      };
      let requests = 0;
      const installed = await prepareEnrolledHarness("https://armada.example", configuration, async () => {
        requests++;
        return new Response(archive);
      });
      const executable = harness === "codex" ? installed.codexExecutable : installed.claudeExecutable;
      const env = harness === "codex" ? installed.codexEnv : installed.claudeEnv;
      expect(await Bun.file(executable).text()).toBe("selected fixture executable");
      expect(executable).toBe(join(root, "artifacts/harnesses", `${harness}-${hash(archive)}`, `bin/${harness}`));
      expect(env.PATH).toBe(
        harness === "codex"
          ? `${join(root, "artifacts/harnesses", `codex-${hash(archive)}`, "codex-path")}:/fixture/tools`
          : "/fixture/tools",
      );
      expect(env[harness === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"]).toBe(
        harness === "codex" ? "synthetic-model-material" : "synthetic-claude-material",
      );
      expect(configuration.codexEnv.PATH).toBe("/fixture/tools");
      expect(requests).toBe(1);
      for (const input of [
        { ...configuration, selectedHarness: "opencode" },
        { ...configuration, selectedHarness: undefined },
        { ...configuration, root: "relative" },
      ])
        await expect(prepareEnrolledHarness("https://armada.example", input)).rejects.toThrow(
          "invalid_enrolled_harness",
        );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
