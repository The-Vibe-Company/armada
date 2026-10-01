import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEMO_TOML } from "../../core/test/support.ts";

const directories: string[] = [];
const preload = join(import.meta.dir, "fixtures/entry-io.ts");
const entry = join(import.meta.dir, "../src/main.ts");
const report = ["report", "implementing", "--ticket", "DEMO-7", "--message-file", "-"];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "armada-stdin-"));
  directories.push(directory);
  await writeFile(join(directory, "armada.toml"), DEMO_TOML);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ scripts: { armada: `bun --preload ${JSON.stringify(preload)} ${JSON.stringify(entry)}` } }),
  );
  return {
    cwd: directory,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      XDG_CONFIG_HOME: join(directory, "config"),
      LINEAR_API_KEY: "synthetic-linear-key",
      GITHUB_TOKEN: "synthetic-github-token",
    },
  };
}

async function execute(command: string, args: string[], input = "", waitForRead = false) {
  const options = await workspace();
  const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (waitForRead && stdout.includes("Reading standard input.\n") && !child.stdin.writableEnded)
      child.stdin.end(input);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
    child.stdin.on("error", reject);
    if (!waitForRead) child.stdin.end(input);
  });
  const record = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { bodies: string[]; writes: string[] };
  return { code, stderr, record };
}

describe("CLI standard input", () => {
  test("a printf pipe through bun run posts both message lines", async () => {
    const result = await execute("bash", [
      "-c",
      `printf "line one\\nline two" | "$1" run armada "\${@:2}"`,
      "armada-stdin",
      process.execPath,
      ...report,
    ]);
    expect(result.code).toBe(0);
    expect(result.record.bodies).toEqual(["Agent status: implementing — line one\n\nline two"]);
  });

  test("a shell heredoc through bun run posts both message lines", async () => {
    const result = await execute("bash", [
      "-c",
      `"$1" run armada "\${@:2}" <<'EOF'\nline one\nline two\nEOF`,
      "armada-stdin",
      process.execPath,
      ...report,
    ]);
    expect(result.code).toBe(0);
    expect(result.record.bodies).toEqual(["Agent status: implementing — line one\n\nline two"]);
  });

  test("a large heredoc reads the shell's redirected input to EOF", async () => {
    const body = "many lines: café 🌊\n".repeat(1_000);
    const result = await execute("bash", [
      "-c",
      `"$1" run armada "\${@:2}" <<'EOF'\nline one\n${body}line two\nEOF`,
      "armada-stdin",
      process.execPath,
      ...report,
    ]);
    expect(result.code).toBe(0);
    expect(result.record.bodies).toEqual([`Agent status: implementing — line one\n\n${body}line two`]);
  });

  test("the entry point reads a large Unicode pipe to EOF", async () => {
    const message = `line one\n${"many lines: café 🌊\n".repeat(10_000)}line two`;
    const result = await execute(process.execPath, ["--preload", preload, entry, ...report], message);
    expect(result.code).toBe(0);
    expect(result.record.bodies).toEqual([`Agent status: implementing — line one\n\n${message.slice(9)}`]);
  });

  test("stdin arriving after the reader starts is not mistaken for EOF", async () => {
    const result = await execute(process.execPath, ["run", "armada", ...report], "line one\nline two", true);
    expect(result.code).toBe(0);
    expect(result.record.bodies).toEqual(["Agent status: implementing — line one\n\nline two"]);
  });

  test.each([
    { name: "report implementing", args: ["report", "implementing", "--ticket", "DEMO-7"] },
    { name: "report ready-to-merge", args: ["report", "ready-to-merge", "--ticket", "DEMO-7"] },
    { name: "ask", args: ["ask", "--ticket", "DEMO-7"] },
    { name: "answer", args: ["answer", "--note", "DEMO-7"] },
  ])("empty input is refused before writes: $name", async ({ args }) => {
    for (const input of ["", " \n\t\r\n"]) {
      const result = await execute(process.execPath, ["run", "armada", ...args, "--message-file", "-"], input);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("standard input is empty or whitespace-only");
      expect(result.stderr).toContain(
        'Next: pass --message "<text>" or pipe a non-empty message into --message-file -',
      );
      expect(result.record).toEqual({ bodies: [], writes: [] });
    }
  });
});
