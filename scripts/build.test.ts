import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the script as a subprocess; replace only its expensive child commands.
for (const scenario of [
  { args: [], compilations: 2 },
  { args: ["--target", "linux-arm64"], compilations: 2 },
  { args: ["--all"], compilations: 8 },
  { args: ["--target", "bad"], compilations: 0, failure: true },
  { args: ["--all", "--target", "bad"], compilations: 0, failure: true },
  { args: ["--all"], compilations: 0, failure: true, failAt: 0 },
  { args: ["--all"], compilations: 2, failure: true, failAt: 2 },
]) {
  test(`build batch ${JSON.stringify(scenario)}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-build-"));
    try {
      await Bun.write(join(root, "build.ts"), Bun.file(join(import.meta.dir, "build.ts")));
      const log = join(root, "calls.jsonl");
      await Bun.write(
        join(root, "preload.ts"),
        `import { appendFileSync } from "node:fs";
let call = 0;
Bun.spawnSync = ((argv) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
  return { exitCode: call++ === ${scenario.failAt ?? -1} ? 1 : 0 };
});`,
      );
      const child = Bun.spawn(
        [process.execPath, "--preload", join(root, "preload.ts"), join(root, "build.ts"), ...scenario.args],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code === 0).toBe(!scenario.failure);
      const calls: string[][] = (await Bun.file(log).exists())
        ? (await Bun.file(log).text())
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      const preparations = calls.filter((call) => call[1]?.endsWith("prepare-runtime.ts"));
      expect(preparations.length).toBe(scenario.args.includes("bad") ? 0 : 1);
      expect(calls.filter((call) => call[1] === "build").length).toBe(scenario.compilations);
      if (preparations.length) expect(calls[0]).toEqual(preparations[0]);
      if (scenario.failAt === 0) expect(stderr).toContain("Pinned runtime preparation failed");
      if (scenario.failAt === 2) expect(stderr).toContain("bun build --compile failed");
      const targets = calls
        .filter((call) => call[1] === "build")
        .map((call) => call.find((arg) => arg.startsWith("--target=")));
      if (!scenario.failure && scenario.args.includes("--all"))
        expect(targets).toEqual(
          ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].flatMap((target) => [
            `--target=bun-${target}`,
            `--target=bun-${target}`,
          ]),
        );
      if (!scenario.failure && scenario.args.includes("--target"))
        expect(targets).toEqual(["--target=bun-linux-arm64", "--target=bun-linux-arm64"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
