import type { GoldenRecord } from "./golden.ts";
import { LaunchError } from "./launch-error.ts";
import { resolveLaunchWorkdir } from "./launch-workdir.ts";

const DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
/** Both public selectors resolve to the immutable configured directory, never a caller-supplied path. */
export function resolveRepositoryDir(golden: GoldenRecord, selector: string | undefined): string | null {
  if (selector === undefined) return null;
  if (selector.includes("/")) return resolveLaunchWorkdir(golden.config.repos, selector).repo.dir;
  const matches = golden.config.repos.filter((repo) => repo.dir === selector);
  if (!DIRECTORY.test(selector) || matches.length !== 1)
    throw new LaunchError(
      "invalid_request",
      "Repository must name one configured directory or owner/repo in this golden.",
    );
  return selector;
}
