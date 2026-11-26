import { closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SKILL_PACKAGE } from "./skill-package.ts";

const WEEK = 7 * 24 * 60 * 60 * 1000;

const SUPPRESSED_COMMANDS = new Set(["skill", "--version", "-v", "completion", "shell"]);

export function printSkillHint(
  argv: readonly string[],
  exitCode: number,
  terminal: { stdout: boolean; stderr: boolean },
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  home?: string,
): void {
  let commandIndex = 0;
  while (commandIndex < argv.length) {
    const arg = argv[commandIndex] ?? "";
    if (arg === "--profile") commandIndex += 2;
    else if (arg.startsWith("--profile=")) commandIndex += 1;
    else break;
  }
  if (
    exitCode !== 0 ||
    !terminal.stdout ||
    !terminal.stderr ||
    env.ARMADA_NO_SKILL_HINT === "1" ||
    argv.includes("--json") ||
    SUPPRESSED_COMMANDS.has(argv[commandIndex] ?? "")
  )
    return;
  try {
    cwd ??= process.cwd();
    home ??= homedir();
    const bases = new Set([home]);
    let current = resolve(cwd);
    for (let depth = 0; depth < 32; depth++) {
      bases.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const base of bases) {
      for (const root of SKILL_PACKAGE.discoveryRoots) {
        try {
          if (statSync(join(base, root, SKILL_PACKAGE.names[0], "SKILL.md")).isFile()) return;
        } catch {}
      }
    }
    const state = join(env.XDG_STATE_HOME || join(home, ".local/state"), "armada");
    const receipt = join(state, "skill-hint");
    const now = Date.now();
    try {
      const prior = statSync(receipt);
      if (!prior.isFile() || now - prior.mtimeMs < WEEK) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const fd = openSync(
      receipt,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      if (!fstatSync(fd).isFile()) return;
      ftruncateSync(fd, 0);
    } finally {
      closeSync(fd);
    }
    process.stderr.write("Armada skills: armada skill install --global --yes (silence: ARMADA_NO_SKILL_HINT=1).\n");
  } catch {}
}
