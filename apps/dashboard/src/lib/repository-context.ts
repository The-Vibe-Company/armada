import { GoldenError, parseGoldenConfig } from "@armada/core";

/**
 * Repository context: which repository of a multi-repo golden the agent is told to work in. It is persisted with
 * the sandbox (`repositoryDir`) and applied by the server at launch. It restricts nothing: every repository of the
 * golden stays available to the agent.
 */

/** The repository directories a launch may name: exactly the golden config's `repos[].dir`, in order. */
export function goldenRepositoryDirs(config: unknown): string[] {
  try {
    return parseGoldenConfig(config).repos.map((repo) => repo.dir);
  } catch (error) {
    if (error instanceof GoldenError) return [];
    throw error;
  }
}

/**
 * The form's choice, checked against the golden's directories. Empty means the default: no repository context
 * is sent and the agent is not pointed at one repository.
 */
export function repositoryChoice(
  value: string,
  dirs: readonly string[],
): { ok: true; repo: string | undefined } | { ok: false; error: string } {
  if (value === "") return { ok: true, repo: undefined };
  if (!dirs.includes(value))
    return { ok: false, error: "That repository is not part of this golden. Reload and try again." };
  return { ok: true, repo: value };
}

/** The repository context a sandbox row recorded at launch, or null when it has none (or predates it). */
export function sandboxRepositoryDir(row: object): string | null {
  const value = (row as { repository_dir?: unknown }).repository_dir;
  return typeof value === "string" && value !== "" ? value : null;
}
