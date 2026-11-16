/** Authenticate durable cleanup receipts before they can authorize deletion. */
export interface ReceiptRun {
  id?: number;
  event: string;
  path: string;
  head_branch: string;
  head_repository: { full_name: string } | null;
  status?: string;
}

export function authenticateSmokeReceipt(run: ReceiptRun, repository: string, release?: ReceiptRun): boolean {
  const trusted = (candidate: ReceiptRun) =>
    candidate.head_repository?.full_name === repository &&
    (candidate.head_branch === "main" || /^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$/.test(candidate.head_branch));
  if (!trusted(run)) return false;
  if (run.event === "workflow_run") {
    return (
      run.path === ".github/workflows/staging-gated-production.yml" &&
      run.head_branch === "main" &&
      release !== undefined &&
      trusted(release) &&
      release.path === ".github/workflows/release.yml" &&
      release.status === "completed" &&
      ["push", "workflow_dispatch"].includes(release.event)
    );
  }
  return (
    ["push", "workflow_dispatch", "deployment_status"].includes(run.event) &&
    [
      ".github/workflows/post-deploy-smoke.yml",
      ".github/workflows/staging-gated-production.yml",
      ".github/workflows/release.yml",
    ].includes(run.path)
  );
}

if (import.meta.main) {
  const [runFile, repository, releaseFile] = process.argv.slice(2);
  if (!runFile || !repository) throw new Error("Receipt run and repository required");
  const run = await Bun.file(runFile).json();
  const release = releaseFile ? await Bun.file(releaseFile).json() : undefined;
  if (!authenticateSmokeReceipt(run, repository, release)) {
    throw new Error("Untrusted staging smoke receipt provenance");
  }
}
