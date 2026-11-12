import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareEnrolledHarness } from "../src/enrolled-harness.ts";

// Owning boundary is bootstrap wiring: installer integrity already belongs to
// harness-cache.test.ts. This checks server selection -> driver executable/env.
test("enrolled bootstrap selects its verified CLI and scopes PATH without mutating credential configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "enrolled-harness-"));
  try {
    const contents = new TextEncoder().encode("selected fixture executable"),
      archive = await new Bun.Archive({ "bin/codex": contents }).bytes(),
      hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const configuration = {
      root,
      selectedHarness: "codex",
      artifactManifest: {
        protocol: 1,
        platform: "linux",
        architecture: process.arch,
        libc: "glibc",
        harnesses: {
          codex: {
            version: "fixture",
            archive: { bytes: archive.length, sha256: hash(archive) },
            executable: "bin/codex",
            files: [{ path: "bin/codex", bytes: contents.length, sha256: hash(contents), executable: true }],
          },
        },
      },
      codexEnv: { PATH: "/fixture/tools", OPENAI_API_KEY: "synthetic-model-material" },
    };
    let requests = 0;
    const installed = await prepareEnrolledHarness("https://armada.example", configuration, async () => {
      requests++;
      return new Response(archive);
    });
    expect(await Bun.file(installed.codexExecutable).text()).toBe("selected fixture executable");
    expect(installed.codexExecutable).toBe(join(root, "artifacts/harnesses", `codex-${hash(archive)}`, "bin/codex"));
    expect(installed.codexEnv.PATH).toBe(
      `${join(root, "artifacts/harnesses", `codex-${hash(archive)}`, "codex-path")}:/fixture/tools`,
    );
    expect(installed.codexEnv.OPENAI_API_KEY).toBe("synthetic-model-material");
    expect(configuration.codexEnv.PATH).toBe("/fixture/tools");
    expect(requests).toBe(1);
    for (const input of [
      { ...configuration, selectedHarness: "claude" },
      { ...configuration, selectedHarness: undefined },
      { ...configuration, root: "relative" },
    ])
      await expect(prepareEnrolledHarness("https://armada.example", input)).rejects.toThrow("invalid_enrolled_harness");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
