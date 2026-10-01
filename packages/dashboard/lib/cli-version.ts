// The dashboard's build version is the ceiling for npm availability checks.
// CLI responses use the published-version cache; the Fleet view compares
// coordinators with the build version, never below the oldest CLI it serves.
import { checkPublished, compareVersions, type Fetch, MINIMUM_CLI_VERSION, versionToInstall } from "@armada/core/read";
import cliPackage from "../../cli/package.json" with { type: "json" };

export const LATEST_CLI_VERSION = versionToInstall(MINIMUM_CLI_VERSION, cliPackage.version);

export const PUBLISHED_CLI_CACHE_MS = 5 * 60_000;

export interface PublishedCli {
  current(): string;
  stale(): boolean;
  refresh(): Promise<void>;
}

export function publishedCli(build: string, fetch: Fetch, now: () => number = Date.now): PublishedCli {
  const baseline = compareVersions(MINIMUM_CLI_VERSION, build) > 0 ? build : MINIMUM_CLI_VERSION;
  let latest = baseline;
  let checkedAt: number | null = null;
  let pending: Promise<void> | null = null;
  const stale = () => checkedAt === null || now() - checkedAt >= PUBLISHED_CLI_CACHE_MS;
  return {
    current: () => latest,
    stale,
    refresh() {
      if (pending) return pending;
      if (!stale()) return Promise.resolve();
      pending = checkPublished(build, fetch)
        .then((answer) => {
          if (answer.state === "published") latest = build;
          if (answer.state === "missing") latest = versionToInstall(baseline, answer.newest);
        })
        .finally(() => {
          checkedAt = now();
          pending = null;
        });
      return pending;
    },
  };
}

export const PUBLISHED_CLI_VERSION = publishedCli(cliPackage.version, fetch);
