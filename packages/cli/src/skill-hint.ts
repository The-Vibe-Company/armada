import { closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SKILL_PACKAGE } from "./skill-package.ts";

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Optional, bounded local advice. No auth, child processes, network, timers or background work. */
export function printSkillHint(
  argv: readonly string[],
  exitCode: number,
  terminal: { stdout: boolean; stderr: boolean },
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  home?: string,
): void {
  if (
    exitCode !== 0 ||
    !terminal.stdout ||
    !terminal.stderr ||
    env.ARMADA_NO_SKILL_HINT === "1" ||
    argv.includes("--json") ||
    argv[0] === "skill"
  )
    return;
  try {
    cwd ??= process.cwd();
    home ??= homedir();
    // Agent discovery includes ancestor projects and user roots. Bound the ancestor walk.
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
        } catch {
          // A missing or unreadable installation is not discoverable.
        }
      }
    }
    const state = join(env.XDG_STATE_HOME || join(home, ".local/state"), "armada");
    const receipt = join(state, "skill-hint");
    const now = Date.now();
    try {
      // Future timestamps also suppress advice after clock rollback.
      const prior = statSync(receipt);
      if (!prior.isFile() || now - prior.mtimeMs < WEEK) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    mkdirSync(state, { recursive: true, mode: 0o700 });
    // Persist before printing. Unwritable state must not cause a hint on every invocation.
    const fd = openSync(
      receipt,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      // Recheck the opened object: replacement after stat must not block or touch a special file.
      if (!fstatSync(fd).isFile()) return;
      ftruncateSync(fd, 0);
    } finally {
      closeSync(fd);
    }
    process.stderr.write("Armada skills: armada skill install --global --yes (silence: ARMADA_NO_SKILL_HINT=1).\n");
  } catch {
    // Advice must never fail the user's command.
  }
}
