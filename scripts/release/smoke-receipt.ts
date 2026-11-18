/** Authenticate durable cleanup receipts before they can authorize deletion. */
export interface ReceiptRun {
  id?: number;
  event: string;
  path: string;
  head_branch: string;
  head_repository: { full_name: string } | null;
  status?: string;
  run_attempt?: number;
}

function authenticateReleaseIdentity(run: ReceiptRun, repository: string): boolean {
  return (
    run.head_repository?.full_name === repository &&
    (run.head_branch === "main" || /^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$/.test(run.head_branch)) &&
    run.path === ".github/workflows/release.yml" &&
    ["push", "workflow_dispatch"].includes(run.event)
  );
}

export function authenticateReleaseCompletion(run: ReceiptRun, repository: string): boolean {
  return run.status === "completed" && authenticateReleaseIdentity(run, repository);
}

export function authenticateSmokeReceiptProducer(run: ReceiptRun, repository: string): boolean {
  if (run.head_repository?.full_name !== repository) return false;
  if (run.event === "workflow_run") {
    return run.path === ".github/workflows/staging-gated-production.yml" && run.head_branch === "main";
  }
  return authenticateSmokeReceipt(run, repository);
}

export function authenticateSmokeReceipt(
  run: ReceiptRun,
  repository: string,
  release?: ReceiptRun,
  currentRunId?: number,
): boolean {
  const trusted = (candidate: ReceiptRun) =>
    candidate.head_repository?.full_name === repository &&
    (candidate.head_branch === "main" || /^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$/.test(candidate.head_branch));
  if (!trusted(run)) return false;
  if (run.event === "workflow_run") {
    if (!authenticateSmokeReceiptProducer(run, repository) || !release) return false;
    // A rerun keeps the Release run ID, but the API now describes its active attempt.
    // The authenticated wakeup producer was admitted using the earlier completion event.
    const isCurrentRerun =
      currentRunId !== undefined &&
      release.id === currentRunId &&
      release.status === "in_progress" &&
      (release.run_attempt ?? 0) > 1;
    return (
      authenticateReleaseCompletion(release, repository) ||
      (isCurrentRerun && authenticateReleaseIdentity(release, repository))
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
  const args = process.argv.slice(2);
  if (args[0] === "--release-completion") {
    const event = await Bun.file(args[1]!).json();
    if (!authenticateReleaseCompletion(event.workflow_run, args[2]!)) {
      throw new Error("Untrusted Release completion wakeup");
    }
    process.exit(0);
  }
  const producerOnly = args[0] === "--producer-only";
  if (producerOnly) args.shift();
  const [runFile, repository, releaseFile] = args;
  if (!runFile || !repository) throw new Error("Receipt run and repository required");
  const run = await Bun.file(runFile).json();
  const release = releaseFile ? await Bun.file(releaseFile).json() : undefined;
  if (
    !(producerOnly
      ? authenticateSmokeReceiptProducer(run, repository)
      : authenticateSmokeReceipt(run, repository, release, Number(process.env.GITHUB_RUN_ID)))
  ) {
    throw new Error("Untrusted staging smoke receipt provenance");
  }
}
