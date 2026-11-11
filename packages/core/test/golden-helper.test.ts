import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../helper/manifest.json";
import { GOLDEN_HELPER_SETUP, verifyGoldenHelper } from "../src/golden-helper.ts";
import type { Provider } from "../src/provider.ts";

// Installation security is exercised by the actual shell + ELF, not string assertions.
test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "installs the inert pinned executable without sudo; bad bytes never execute",
  async () => {
    for (const corrupt of [false, true]) {
      const home = mkdtempSync(join(tmpdir(), "golden-helper-"));
      try {
        let script = GOLDEN_HELPER_SETUP.replaceAll("/home/user", home);
        if (corrupt)
          script = script.replace(
            manifest.x86_64.base64,
            Buffer.from(`#!/bin/sh\ntouch '${home}/executed'\n`).toString("base64"),
          );
        const result = Bun.spawnSync(["bash", "-euc", script], { env: { PATH: "/usr/bin:/bin", HOME: home } });
        expect(result.exitCode).toBe(corrupt ? 98 : 0);
        expect(existsSync(join(home, "executed"))).toBe(false);
        const binary = join(home, ".local/bin/armada-helper");
        expect(existsSync(binary)).toBe(!corrupt);
        if (!corrupt) {
          expect(createHash("sha256").update(readFileSync(binary)).digest("hex")).toBe(manifest.x86_64.digest);
          const report = Bun.spawnSync([binary], { env: {} });
          expect(report.exitCode).toBe(0);
          expect(JSON.parse(report.stdout.toString())).toEqual({
            version: "0.1.0",
            protocol: 1,
            capabilities: ["diagnose"],
          });
          // Execute the production post-init verifier against those installed bytes.
          const provider = {
            exec: async ({ command }: { command: string }) => {
              const checked = Bun.spawnSync(["bash", "-euc", command.replaceAll("/home/user", home)]);
              return {
                detached: false,
                exitCode: checked.exitCode,
                stdout: checked.stdout.toString().replaceAll(home, "/home/user"),
                stderr: checked.stderr.toString(),
                truncated: false,
                timedOut: false,
              };
            },
          } as unknown as Provider;
          expect(await verifyGoldenHelper(provider, "builder")).toMatchObject({
            digest: manifest.x86_64.digest,
            protocol: 1,
          });
          writeFileSync(binary, `#!/bin/sh\ntouch '${home}/executed'\n`, { mode: 0o755 });
          await expect(verifyGoldenHelper(provider, "builder")).rejects.toThrow("integrity");
          expect(existsSync(join(home, "executed"))).toBe(false);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);

test("browser core entry excludes native payloads while sharing release digests", async () => {
  const digests = (await import("../helper/digests.json")).default;
  for (const platform of ["x86_64", "aarch64"] as const) expect(digests[platform]).toBe(manifest[platform].digest);
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/index.ts")],
    target: "browser",
  });
  expect(build.success).toBe(true);
  const bundle = await build.outputs[0]!.text();
  for (const platform of ["x86_64", "aarch64"] as const) expect(bundle).not.toContain(manifest[platform].base64);
});
