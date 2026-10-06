import type { Io } from "./io.ts";
import { readSigning } from "./signing.ts";

/** A local check after claim: never moves a ref, prompts or changes Git configuration. */
export async function preflight(io: Io, branch: string | null): Promise<string | null> {
  // Embedded callers may provide no command runner; the real CLI always has one.
  if (!io.exec) return null;
  const root = io.coordinatorRoot ?? io.cwd;
  if (!branch) return "cannot push worker branch: the claim has no branch";
  for (const [action, args] of [
    ["fetch origin", ["ls-remote", "origin", "HEAD"]],
    [`push ${branch}`, ["push", "--dry-run", "origin", `HEAD:refs/heads/${branch}`]],
  ] as const) {
    const result = await io
      .exec("git", [...args], {
        cwd: root,
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
        processGroup: true,
        env: { ...io.env, GIT_TERMINAL_PROMPT: "0" },
      })
      .catch(() => null);
    if (!result) return `cannot ${action}: git could not be run`;
    if (result.timedOut) return `cannot ${action}: timed out after 10 seconds`;
    if (result.outputExceeded) return `cannot ${action}: Git output exceeded the check's limit`;
    if (result.code !== 0) {
      // Remote URLs can carry credentials unknown to Armada. Keep Git's reason,
      // scrub URLs and control characters before the normal outgoing redactor.
      const reason = (result.stderr.trim() || result.stdout.trim())
        .replace(/\b(?:https?|ssh):\/\/[^\s'"<>]+/gi, "[repository URL]")
        .replace(/\p{Cc}\[[0-9;]*[A-Za-z]/gu, "")
        .replace(/\p{Cc}+/gu, " ");
      return `cannot ${action}: ${reason || `git exited ${result.code}`}`;
    }
  }
  // Six config reads and optional gpgconf, each at most one second: the
  // entire preflight is bounded by 27 seconds of child execution.
  const signing = await readSigning(io, root, 1_000);
  if (!signing) return "cannot check commit signing: effective Git configuration could not be read";
  if (signing.interactive) return `cannot commit without a person: signing uses ${signing.interactive}`;
  return null;
}
