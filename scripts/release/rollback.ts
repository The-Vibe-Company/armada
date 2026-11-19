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
    migrations,
    productionMigrationHistory,
    surfaceBreak,
    runtime: protocol(protocols.runtime),
    dockerHost: protocol(protocols.dockerHost),
  };
}

export function rollbackRefusal(
  requested: string,
  current: Release,
  previous: Release,
  health: unknown,
  currentAsset: unknown,
  previousAsset: unknown,
) {
  if (requested !== previous.tag) return "target is not the previous stable release";
  if (!matchesDeploymentHealth(health, current.tag.slice(1), current.sha)) return "current deployment unverified";
  const receipt = readReceipt(currentAsset, current);
  if (!receipt) return "current receipt unavailable or invalid";
  if (receipt.previousVersion !== previous.tag.slice(1)) return "current receipt names a different previous release";
  if (receipt.migrations.length) return "migrations";
  const target = readReceipt(previousAsset, previous);
  if (!target) return "target receipt unavailable or invalid";
  if (!Bun.deepEquals(receipt.productionMigrationHistory, target.productionMigrationHistory)) return "migrations";
  for (const key of ["runtime", "dockerHost"] as const) {
    const { from, to } = receipt[key];
    if (from === null || from !== to || from !== target[key].to) return "protocol bump or missing protocol evidence";
  }
  if (receipt.surfaceBreak.length) return "surface break or missing surface evidence";
  return null;
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
  if (!stableTag.test(requested)) return "expected a stable tag such as v3.0.0";
  const [latest, prior] = command("git", "tag", "--list", "v*", "--sort=-version:refname")
    .split("\n")
    .filter((tag) => stableTag.test(tag));
  if (!latest || !prior) return "two stable release tags are required";
  if (requested !== prior) return "target is not the previous stable release";
  const release = (tag: string) =>
    ({ tag, sha: command("git", "rev-parse", `refs/tags/${tag}^{commit}`) }) satisfies Release;
  return rollbackRefusal(requested, release(latest), release(prior), await health(), receipt(latest), receipt(prior));
}

if (import.meta.main) {
  const reason = await preflight(process.env.ROLLBACK_TO_VERSION ?? "");
  if (reason) {
    console.error(`rollback: refused (${reason})`);
    process.exitCode = 1;
  } else {
    console.log("rollback: eligible at preflight (no host changes performed)");
  }
}
