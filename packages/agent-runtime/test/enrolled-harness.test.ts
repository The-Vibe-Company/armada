import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ANTIGRAVITY_ARTIFACT } from "../src/antigravity-artifact.ts";
import {
  bootstrapGitHubHomes,
  initializeBootstrapHarnessHomes,
  prepareEnrolledHarness,
  selectBootstrapHarnesses,
  shouldPrepareLocalOpenCode,
} from "../src/enrolled-harness.ts";

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

test("Antigravity enrollment requires a private model credential before artifact access", async () => {
  const root = await mkdtemp(join(tmpdir(), "enrolled-antigravity-"));
  try {
    await expect(
      prepareEnrolledHarness(
        "https://armada.example",
        { root, selectedHarness: "antigravity", claudeEnv: {}, codexEnv: {} },
        async () => {
          throw Error("unexpected artifact fetch");
        },
      ),
    ).rejects.toThrow("Invalid Antigravity credential.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux" || !["arm64", "x64"].includes(process.arch))(
  "Antigravity enrollment requests the pinned native artifact without transmitting the model key",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "enrolled-antigravity-"));
    const serverUrl = "https://armada.example";
    const pin = ANTIGRAVITY_ARTIFACT[process.arch === "arm64" ? "arm64" : "x64"];
    try {
      const requests: Request[] = [];
      await expect(
        prepareEnrolledHarness(
          serverUrl,
          {
            root,
            artifactManifest: { antigravity: { url: "https://elsewhere.example/cli.tar.gz" } },
            selectedHarness: "antigravity",
            claudeEnv: {},
            codexEnv: {},
            antigravityCredential: { method: "gemini-api-key", apiKey: "fixture-model-material" },
          },
          async (url, options) => {
            requests.push(new Request(url.href, options));
            return new Response(null, { status: 404 });
          },
          join(root, "shared"),
        ),
      ).rejects.toThrow("runtime_artifact_unavailable");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe(pin.url);
      expect(requests[0]!.redirect).toBe("error");
      expect(requests[0]!.method).toBe("GET");
      expect(requests[0]!.body).toBeNull();
      expect(JSON.stringify([...requests[0]!.headers])).not.toContain("fixture-model-material");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// OpenCode uses a standalone checksum-pinned binary, not a harness archive.
test.skipIf(process.platform !== "linux")(
  "enrolled OpenCode selects the verified warm binary without unrelated harnesses",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "enrolled-opencode-"));
    try {
      const require = createRequire(import.meta.url);
      const fromOpenCode = createRequire(require.resolve("opencode-ai/package.json"));
      const candidate = join(root, "artifacts", "opencode");
      await mkdir(join(root, "artifacts"), { mode: 0o700 });
      await copyFile(
        join(dirname(fromOpenCode.resolve(`opencode-linux-${process.arch}/package.json`)), "bin/opencode"),
        candidate,
      );
      await chmod(candidate, 0o700);
      const selected = await prepareEnrolledHarness(
        "https://armada.example",
        {
          root,
          selectedHarness: "opencode",
          claudeEnv: {},
          codexEnv: {},
          opencodeEnv: { OPENCODE_API_KEY: "synthetic-opencode-material", PATH: "/fixture/tools" },
        },
        async () => {
          throw Error("unexpected archive fetch");
        },
      );
      expect(selected.opencodeExecutable).toBe(candidate);
      expect(selected.opencodeEnv).toEqual({ OPENCODE_API_KEY: "synthetic-opencode-material", PATH: "/fixture/tools" });
      expect(selected.codexExecutable).toBe("");
      expect(selected.claudeExecutable).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("enrolled bootstrap initializes only the selected harness home and skips duplicate OpenCode preparation", async () => {
  expect(shouldPrepareLocalOpenCode(true, { OPENCODE_API_KEY: "synthetic-key" })).toBe(false);
  expect(shouldPrepareLocalOpenCode(true, { OPENCODE_CONFIG_CONTENT: "{}" })).toBe(false);
  expect(shouldPrepareLocalOpenCode(false, { OPENCODE_API_KEY: "synthetic-key" })).toBe(true);
  expect(shouldPrepareLocalOpenCode(false, {})).toBe(false);
  expect(selectBootstrapHarnesses(false, undefined)).toEqual(["opencode", "claude", "codex"]);
  expect(selectBootstrapHarnesses(true, "antigravity")).toEqual([]);

  for (const selected of ["codex", "claude", "opencode"] as const) {
    const root = await mkdtemp(join(tmpdir(), `single-harness-${selected}-`));
    try {
      const harnesses = selectBootstrapHarnesses(true, selected);
      expect(harnesses).toEqual([selected]);
      const envs = {
        opencode: {} as Record<string, string>,
        claude: {} as Record<string, string>,
        codex: {} as Record<string, string>,
      };
      const created = await initializeBootstrapHarnessHomes({ root, harnesses, envs, execEnv: { HOME: "/home/user" } });
      expect(created).toEqual([`${root}/${selected}/home`]);
      expect(await readdir(root)).toEqual([selected]);
      expect(bootstrapGitHubHomes("/home/user", harnesses, envs)).toEqual(["/home/user", `${root}/${selected}/home`]);
      for (const other of ["opencode", "claude", "codex"] as const) {
        if (other !== selected) expect(envs[other].HOME).toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
