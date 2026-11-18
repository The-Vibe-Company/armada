import type { SandboxPullRequest } from "@armada/core";

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/;
const STATES = new Set<SandboxPullRequest["state"]>(["open", "merged", "closed"]);

/**
 * The confirmed pull requests of a sandbox (#2612), or null when the viewer may not see them. The server writes the
 * list from GitHub, but it is validated again: an entry whose link does not lead to that GitHub pull request is left
 * out, never shown from a guess.
 */
export function parsePullRequests(value: unknown): SandboxPullRequest[] | null {
  if (!Array.isArray(value)) return null;
  const list: SandboxPullRequest[] = [];
  for (const item of value.slice(0, 64)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { repository, number, url, headBranch, state, checkedAt } = item as Record<string, unknown>;
    if (typeof url !== "string" || typeof repository !== "string" || typeof number !== "number") continue;
    const match = PR_URL.exec(url);
    if (!match || match[1]?.toLowerCase() !== repository.toLowerCase() || Number(match[2]) !== number) continue;
    if (typeof state !== "string" || !STATES.has(state as SandboxPullRequest["state"])) continue;
    if (typeof headBranch !== "string" || typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt)))
      continue;
    list.push({ repository, number, url, headBranch, state: state as SandboxPullRequest["state"], checkedAt });
  }
  return list;
}
