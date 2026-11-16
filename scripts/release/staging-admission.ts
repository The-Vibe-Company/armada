import { appendFileSync } from "node:fs";

export interface ReleaseReservation {
  status: string;
  path: string;
  head_repository: { full_name: string } | null;
}

/** A queued release already owns priority; ordinary staging yields without mutation. */
export function shouldDeferStaging(runs: ReleaseReservation[], repository: string): boolean {
  return runs.some(
    (run) =>
      run.head_repository?.full_name === repository &&
      run.path === ".github/workflows/release.yml" &&
      run.status !== "completed",
  );
}

if (import.meta.main) {
  const repository = process.env.GH_REPO;
  const token = process.env.GH_TOKEN;
  const output = process.env.GITHUB_OUTPUT;
  if (!repository || !token || !output) throw new Error("Missing staging admission configuration");
  // Holding release-production prevents a queued Release from starting between
  // status queries. Bound lookup cost independently of repository history.
  const reservations = await Promise.all(
    ["queued", "in_progress", "waiting", "pending", "requested"].map(async (status) => {
      for (let page = 1; page <= 10; page++) {
        const response = await fetch(
          `https://api.github.com/repos/${repository}/actions/workflows/release.yml/runs?status=${status}&per_page=100&page=${page}`,
          {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!response.ok) throw new Error(`Cannot verify release reservation (HTTP ${response.status})`);
        const data = (await response.json()) as { workflow_runs?: ReleaseReservation[] };
        if (!Array.isArray(data.workflow_runs)) throw new Error("Invalid release reservation response");
        if (shouldDeferStaging(data.workflow_runs, repository)) return true;
        if (data.workflow_runs.length < 100) return false;
      }
      throw new Error("Release reservation lookup exceeded its bound; staging blocked");
    }),
  );
  const deferred = reservations.some(Boolean);
  appendFileSync(output, `deferred=${deferred}\n`);
  if (deferred) console.log("Release reserved staging; newest main resumes automatically after Release completes.");
}
