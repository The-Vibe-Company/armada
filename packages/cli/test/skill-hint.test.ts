import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_PACKAGE } from "../src/skill-package.ts";

const temps: string[] = [];
afterEach(async () => {
  for (const path of temps.splice(0)) await rm(path, { recursive: true, force: true });
});

// Real entrypoint and PTY: protects stdout/JSON/pipes, discovery, cooldown and opt-out,
// not duplicated private predicates. No real Armada API or wall-clock waits.
test("terminal-only skill advice is occasional, silenceable and stops after discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-hint-"));
  temps.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project", "nested");
  const state = join(root, "state");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const receipt = join(state, "armada/skill-hint");
  const main = join(import.meta.dir, "../src/main.ts");
  function cli(args: string[], tty = true, extraEnv: Record<string, string> = {}) {
    const child = Bun.spawnSync(
      [
        "python3",
        "-c",
        `
import os, pty, subprocess, sys, errno
if sys.argv[1] == "pipe":
 p = subprocess.run(sys.argv[2:], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
 sys.stdout.buffer.write(p.stdout + p.stderr)
 sys.exit(p.returncode)
master, slave = pty.openpty()
p = subprocess.Popen(sys.argv[2:], stdout=slave, stderr=slave)
os.close(slave)
while True:
 try:
  b = os.read(master, 65536)
  if not b: break
  sys.stdout.buffer.write(b)
 except OSError as e:
  if e.errno != errno.EIO: raise
  break
os.close(master)
sys.exit(p.wait())
`,
        tty ? "tty" : "pipe",
        process.execPath,
        main,
        ...args,
      ],
      {
        cwd,
        env: { ...process.env, HOME: home, XDG_STATE_HOME: state, ARMADA_NO_SKILL_HINT: "", ...extraEnv },
      },
    );
    expect(child.exitCode).toBe(0);
    return child.stdout.toString();
  }
  for (const [args, tty, env] of [
    [["--version"], false, {}],
    [["--version", "--json"], true, {}],
    [["--version"], true, { ARMADA_NO_SKILL_HINT: "1" }],
    [["skill", "--help"], true, {}],
  ] as const) {
    expect(cli([...args], tty, env)).not.toContain("silence:");
    expect(await Bun.file(receipt).exists()).toBe(false);
  }
  expect(cli(["--version"])).toContain("armada skill install --global --yes");
  expect(await readFile(receipt, "utf8")).toBe("");
  expect(cli(["--version"])).not.toContain("silence:");
  await utimes(receipt, new Date(0), new Date(0));
  expect(cli(["--version"])).toContain("silence:");
  await rm(receipt);
  for (const base of [home, join(root, "project")]) {
    for (const discovery of SKILL_PACKAGE.discoveryRoots) {
      const skill = join(base, discovery, SKILL_PACKAGE.names[0]);
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, "SKILL.md"), "fixture");
      expect(cli(["--version"])).not.toContain("silence:");
      expect(await Bun.file(receipt).exists()).toBe(false);
      await rm(skill, { recursive: true });
    }
  }
  // Read-only/unusable state cannot repeatedly print advice or fail the command.
  await rm(join(state, "armada"), { recursive: true });
  await writeFile(join(state, "armada"), "not a directory");
  expect(cli(["--version"])).not.toContain("silence:");
});

test("unavailable working directory never breaks a completed command, including quiet paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-hint-cwd-"));
  temps.push(directory);
  const module = new URL("../src/skill-hint.ts", import.meta.url).href;
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
      const { printSkillHint } = await import(${JSON.stringify(module)});
      const { rmdirSync } = await import("node:fs");
      process.chdir(${JSON.stringify(directory)});
      rmdirSync(${JSON.stringify(directory)});
      for (const args of [[], ["--json"]]) {
        printSkillHint(args, 0, { stdout: true, stderr: true });
        printSkillHint(args, 0, { stdout: false, stderr: false });
      }
      `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toBe("");
});
