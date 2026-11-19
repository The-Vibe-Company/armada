import { matchesDeploymentHealth } from "./deployment-health";

const stableTag = /^v\d+\.\d+\.\d+$/;
type Release = { tag: string; sha: string };

function record(value: unknown) {
  const empty: Record<string, unknown> = {};
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : empty;
}

function stringList(value: unknown, pattern: RegExp): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && pattern.test(entry));
}

function protocol(value: unknown) {
  const { from, to } = record(value);
  return {
    from: Number.isSafeInteger(from) && Number(from) > 0 ? Number(from) : null,
    to: Number.isSafeInteger(to) && Number(to) > 0 ? Number(to) : null,
  };
}

function readReceipt(value: unknown, release: Release) {
  const receipt = record(value);
  const { imageDigest, migrations, productionMigrationHistory, surfaceBreak } = receipt;
  if (
    receipt.version !== release.tag.slice(1) ||
    receipt.sha !== release.sha ||
    !/^[a-f0-9]{40}$/.test(release.sha) ||
    typeof receipt.serverDeployment !== "string" ||
    !receipt.serverDeployment.trim() ||
    typeof receipt.dashboardDeployment !== "string" ||
    !receipt.dashboardDeployment.trim() ||
    (imageDigest !== null && (typeof imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageDigest))) ||
    !stringList(migrations, /^\d{14}$/) ||
    !stringList(productionMigrationHistory, /^\d{14}$/) ||
    !stringList(surfaceBreak, /\S/)
  )
    return null;
  const protocols = record(receipt.protocolBump);
  return {
    previousVersion: receipt.previousVersion,
    serverDeployment: receipt.serverDeployment,
    dashboardDeployment: receipt.dashboardDeployment,
    imageDigest,
    migrations,
    productionMigrationHistory,
    surfaceBreak,
    runtime: protocol(protocols.runtime),
    dockerHost: protocol(protocols.dockerHost),
  };
}

export function planRollback(
  requested: string,
  current: Release,
  previous: Release,
  health: unknown,
  currentAsset: unknown,
  previousAsset: unknown,
) {
  if (requested !== previous.tag) return { refusal: "target is not the previous stable release" } as const;
  if (!matchesDeploymentHealth(health, current.tag.slice(1), current.sha))
    return { refusal: "current deployment unverified" } as const;
  const receipt = readReceipt(currentAsset, current);
  if (!receipt) return { refusal: "current receipt unavailable or invalid" } as const;
  if (receipt.previousVersion !== previous.tag.slice(1))
    return { refusal: "current receipt names a different previous release" } as const;
  if (receipt.migrations.length) return { refusal: "migrations" } as const;
  const target = readReceipt(previousAsset, previous);
  if (!target) return { refusal: "target receipt unavailable or invalid" } as const;
  if (!Bun.deepEquals(receipt.productionMigrationHistory, target.productionMigrationHistory))
    return { refusal: "migrations" } as const;
  for (const key of ["runtime", "dockerHost"] as const) {
    const { from, to } = receipt[key];
    if (from === null || from !== to || from !== target[key].to)
      return { refusal: "protocol bump or missing protocol evidence" } as const;
  }
  if (receipt.surfaceBreak.length) return { refusal: "surface break or missing surface evidence" } as const;
  if (!/^dpl_[A-Za-z0-9]+$/.test(target.dashboardDeployment))
    return { refusal: "target dashboard deployment ID invalid" } as const;
  return {
    current,
    previous,
    currentDashboard: receipt.dashboardDeployment,
    currentServer: receipt.serverDeployment,
    targetDashboard: target.dashboardDeployment,
    targetImage: target.imageDigest,
    migrations: receipt.productionMigrationHistory,
  };
}

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { timeout: 30_000 });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

function receipt(tag: string) {
  try {
    return JSON.parse(
      command("gh", "release", "download", tag, "--pattern", "release-receipt.json", "--output", "-"),
    ) as unknown;
  } catch {
    return null;
  }
}

async function health() {
  const url = process.env.ARMADA_SERVER_URL;
  if (!url) return null;
  try {
    const endpoint = new URL(url);
    if (endpoint.protocol !== "https:") return null;
    const response = await fetch(new URL("/healthz", endpoint), {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? ((await response.json()) as unknown) : null;
  } catch {
    return null;
  }
}

async function preflight(requested: string) {
  if (!stableTag.test(requested)) return { refusal: "expected a stable tag such as v3.0.0" } as const;
  const [latest, prior] = command("git", "tag", "--list", "v*", "--sort=-version:refname")
    .split("\n")
    .filter((tag) => stableTag.test(tag));
  if (!latest || !prior) return { refusal: "two stable release tags are required" } as const;
  if (requested !== prior) return { refusal: "target is not the previous stable release" } as const;
  const release = (tag: string) =>
    ({ tag, sha: command("git", "rev-parse", `refs/tags/${tag}^{commit}`) }) satisfies Release;
  return planRollback(requested, release(latest), release(prior), await health(), receipt(latest), receipt(prior));
}

async function verifyMigrationHistory(expected: unknown) {
  const { SUPABASE_DB_URL, SUPABASE_DB_PASSWORD } = process.env;
  if (!SUPABASE_DB_URL || !SUPABASE_DB_PASSWORD) return false;
  try {
    const url = new URL(SUPABASE_DB_URL);
    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") return false;
    const sslmode = url.searchParams.get("sslmode");
    if (sslmode !== "verify-full" && sslmode !== "verify-ca") url.searchParams.set("sslmode", "require");
    const sql = new Bun.SQL(url, { password: SUPABASE_DB_PASSWORD, max: 1, prepare: false, connectionTimeout: 10 });
    try {
      const versions = await sql.begin("READ ONLY", async (tx) => {
        await tx`SET LOCAL statement_timeout = '10s'`;
        const rows = await tx<{ version: string }[]>`
          SELECT version::text FROM supabase_migrations.schema_migrations ORDER BY version
        `;
        return rows.map(({ version }) => version);
      });
      return Bun.deepEquals(versions, expected);
    } finally {
      await sql.close({ timeout: 1 });
    }
  } catch {
    return false;
  }
}

async function verifyDashboard(id: string, sha: string) {
  const { VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID } = process.env;
  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID || !/^dpl_[A-Za-z0-9]+$/.test(id)) return false;
  const url = new URL("/v7/deployments", "https://api.vercel.com");
  url.search = new URLSearchParams({
    projectId: VERCEL_PROJECT_ID,
    target: "production",
    state: "READY",
    rollbackCandidate: "true",
    limit: "100",
  }).toString();
  if (VERCEL_ORG_ID?.startsWith("team_")) url.searchParams.set("teamId", VERCEL_ORG_ID);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const { deployments } = record(response?.ok ? await response.json().catch(() => null) : null);
  return (
    Array.isArray(deployments) &&
    deployments.some((entry) => {
      const deploy = record(entry);
      return (
        deploy.uid === id &&
        deploy.projectId === VERCEL_PROJECT_ID &&
        deploy.target === "production" &&
        deploy.state === "READY" &&
        record(deploy.meta).githubCommitSha === sha
      );
    })
  );
}

if (import.meta.main) {
  const [mode, first, second] = process.argv.slice(2);
  if (mode === "verify-history") {
    process.exit((await verifyMigrationHistory(await Bun.stdin.json())) ? 0 : 1);
  }
  if (mode === "verify-dashboard") {
    process.exit((await verifyDashboard(first ?? "", second ?? "")) ? 0 : 1);
  }
  const plan = await preflight(process.env.ROLLBACK_TO_VERSION ?? "");
  if ("refusal" in plan) {
    console.error(`rollback: refused (${plan.refusal})`);
    process.exitCode = 1;
  } else if (mode === "plan") {
    console.log(JSON.stringify(plan));
  } else {
    console.log("rollback: eligible at preflight (no host changes performed)");
  }
}
