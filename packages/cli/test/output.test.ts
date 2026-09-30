import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_TOML } from "../../core/test/support.ts";

const entry = join(import.meta.dir, "../src/main.ts");
const preload = join(import.meta.dir, "fixtures/entry-output.ts");
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "armada-output-"));
  await writeFile(join(directory, "armada.toml"), DEMO_TOML);
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/bin.ts"), preload],
    target: "node",
    external: ["@libsql/client"],
    outdir: directory,
    naming: "[name].[ext]",
  });
  expect(result.success).toBe(true);
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function execute(runtime: string, args: string[]) {
  const command = runtime === "Bun" ? process.execPath : "node";
  const loader =
    runtime === "Bun"
      ? ["--preload", preload, entry]
      : ["--import", join(directory, "entry-output.js"), join(directory, "bin.js")];
  const child = spawn(command, [...loader, ...args], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: join(directory, "config"),
      LINEAR_API_KEY: "synthetic-linear-key",
      GITHUB_TOKEN: "synthetic-github-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, stdout, stderr };
}

describe.each(["Bun", "Node"])("CLI piped output under %s", (runtime) => {
  test("status --json writes a large Unicode result completely before exiting", async () => {
    const result = await execute(runtime, ["status", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(500_000);
    expect(JSON.parse(result.stdout).programRoot.title).toBe("café 🌊\n".repeat(50_000));
    expect(result.stdout).toEndWith("}\n");
  });

  test("a large error is written completely and keeps the usage exit code", async () => {
    const command = `unknown-${"café 🌊".repeat(10_000)}`;
    const result = await execute(runtime, [command]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `armada: unknown command "${command}"\nNext: armada --help, which lists every command\n`,
    );
  });
});
