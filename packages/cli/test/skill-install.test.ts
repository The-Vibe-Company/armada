import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { copySkillPackages } from "../src/skill-install.ts";

const temps: string[] = [];
afterEach(async () => {
  for (const path of temps.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "skill-test-")));
  temps.push(temp);
  const source = join(temp, "source");
  for (const name of ["armada-manager", "ship-pr-dev", "review-code-dev", "capture-learning-tools"]) {
    const dir = join(source, ".agents/skills", name);
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
    await writeFile(join(dir, "scripts/helper.py"), "print('helper')");
  }
  return { temp, source, target: join(temp, "target") };
}

test("installs whole dependency packages into both discovery roots and preserves unrelated configuration", async () => {
  const { source, target } = await fixture();
  await mkdir(join(target, ".claude/skills/unrelated"), { recursive: true });
  await writeFile(join(target, ".claude/settings.json"), "{}");
  const installed = await copySkillPackages(source, target);
  expect(installed).toHaveLength(8);
  for (const root of [".agents", ".claude"]) {
    expect(await readFile(join(target, root, "skills/review-code-dev/scripts/helper.py"), "utf8")).toBe(
      "print('helper')",
    );
  }
  expect(await readFile(join(target, ".claude/settings.json"), "utf8")).toBe("{}");
});

test("preflights all destinations before writing and refuses customized skills and symlink parents", async () => {
  const { source, target, temp } = await fixture();
  const custom = join(target, ".claude/skills/capture-learning-tools");
  await mkdir(custom, { recursive: true });
  await writeFile(join(custom, "SKILL.md"), "custom");
  await expect(copySkillPackages(source, target)).rejects.toThrow("Destination already exists");
  expect(await readFile(join(custom, "SKILL.md"), "utf8")).toBe("custom");
  expect(await Bun.file(join(target, ".agents/skills/armada-manager/SKILL.md")).exists()).toBe(false);
  await rm(target, { recursive: true });
  await mkdir(target);
  await symlink(temp, join(target, ".agents"));
  await expect(copySkillPackages(source, target)).rejects.toThrow("symlinks refused");
});

test("missing dependencies and source symlinks fail closed before copying", async () => {
  const { source, target, temp } = await fixture();
  const dep = join(source, ".agents/skills/capture-learning-tools");
  await rm(dep, { recursive: true });
  await expect(copySkillPackages(source, target)).rejects.toThrow();
  await mkdir(dep);
  await writeFile(join(dep, "SKILL.md"), "---\n---");
  await symlink(temp, join(dep, "outside"));
  await expect(copySkillPackages(source, target)).rejects.toThrow("symlink");
  expect(await Bun.file(join(target, ".agents/skills/armada-manager/SKILL.md")).exists()).toBe(false);
});

test("CLI requires explicit scope and consent, rejects unknown options and invalid revisions without authentication", async () => {
  for (const argv of [
    ["install"],
    ["install", "--global"],
    ["install", "--global", "--project=", "--yes"],
    ["install", "--project=", "--yes"],
    ["install", "--global", "--project", "/tmp/x", "--yes"],
    ["install", "--global", "--yes", "--revision", "$(touch bad)"],
    ["install", "--global", "--yes", "--json"],
  ]) {
    let error = "";
    expect(
      await run(
        ["skill", ...argv],
        {
          out() {},
          err(text) {
            error += text;
          },
        },
        {
          fetch: (() => {
            throw new Error("must not authenticate");
          }) as unknown as typeof fetch,
        },
      ),
    ).toBe(2);
    expect(error).toContain("Usage:");
  }
});

test("public CLI reports a missing Git prerequisite without a login or raw subprocess diagnostics", async () => {
  const { temp, target } = await fixture();
  const child = Bun.spawn(
    [process.execPath, "packages/cli/src/main.ts", "skill", "install", "--project", target, "--yes"],
    {
      cwd: process.cwd(),
      env: { PATH: temp, HOME: temp },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("Git is required");
  expect(await new Response(child.stdout).text()).toBe("");
});

test("CLI fetches one pinned Git source and reports its actual commit and both installed agent roots", async () => {
  const { source, target, temp } = await fixture();
  for (const args of [
    ["init", "--quiet", source],
    ["-C", source, "add", "."],
    [
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
  ]) {
    expect(Bun.spawnSync(["git", ...args]).exitCode).toBe(0);
  }
  await symlink(tmpdir(), join(temp, "linked-tmp"));
  const commit = Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"]).stdout.toString().trim();
  const child = Bun.spawn(
    [
      process.execPath,
      "packages/cli/src/main.ts",
      "skill",
      "install",
      "--project",
      target,
      "--yes",
      "--revision",
      commit,
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: temp,
        TMPDIR: join(temp, "linked-tmp"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${source}.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/The-Vibe-Company/armada.git",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect(error).toBe("");
  expect(await child.exited).toBe(0);
  expect(output).toContain(`https://github.com/The-Vibe-Company/armada/tree/${commit}/.agents/skills`);
  for (const root of [".agents", ".claude"]) {
    const destination = join(target, root, "skills/armada-manager");
    expect(output).toContain(`Installed: ${destination}`);
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toContain("name: armada-manager");
  }
});
