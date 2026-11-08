import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOLDEN_ROOT, GoldenError } from "../src/golden-config.ts";
import { nativeHarnessWrapper, resolveLaunchWorkdir, resolveLaunchWorkdirAt } from "../src/launch-workdir.ts";

const repos = [
  { url: "https://github.com/acme/repo-a.git", branch: "main", dir: "repo-a" },
  { url: "git@github.com:acme/repo-b.git", branch: "main", dir: "repo-b" },
] as const;

test("selects recorded owner/repo and starts the native executable in that exact workdir", () => {
  expect(resolveLaunchWorkdir(repos, "acme/repo-b").cwd).toBe(`${GOLDEN_ROOT}/repo-b`);
  const base = mkdtempSync(join(tmpdir(), "armada-workdir-"));
  try {
    const root = join(base, "goldens");
    const workdir = resolveLaunchWorkdirAt(repos, "acme/repo-b", root);
    mkdirSync(workdir.cwd, { recursive: true });
    const bin = join(base, "bin");
    const output = join(base, "output");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$PWD" > ${JSON.stringify(output)}\nprintf '%s\\n' "$@" >> ${JSON.stringify(output)}\n`,
    );
    chmodSync(join(bin, "codex"), 0o755);
    const wrapper = nativeHarnessWrapper("codex", workdir, ["--model", "gpt", "-C", "/ignored", "--", "-C", "literal"]);
    const result = spawnSync("bash", ["-c", wrapper], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(result.status).toBe(0);
    const contents = readFileSync(output, "utf8").trim().split("\n");
    expect(contents).toEqual([workdir.cwd, "--model", "gpt", "--", "-C", "literal"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("rejects unknown, ambiguous, and invalid recorded repository directories", () => {
  expect(() => resolveLaunchWorkdir(repos, "acme/missing")).toThrow(GoldenError);
  expect(() => resolveLaunchWorkdir([...repos, { ...repos[0], dir: "copy" }], "acme/repo-a")).toThrow("ambiguous");
  expect(() => resolveLaunchWorkdir([{ ...repos[0], dir: "../escape" }], "acme/repo-a")).toThrow(
    "directory is invalid",
  );
});

test("wrapper preparation is idempotent for the same recorded repo and argv", () => {
  const workdir = resolveLaunchWorkdir(repos, "acme/repo-a");
  const argv = ["--model", "x", "--cd=/ignored", "task"];
  expect(nativeHarnessWrapper("claude", workdir, argv)).toBe(nativeHarnessWrapper("claude", workdir, argv));
});
