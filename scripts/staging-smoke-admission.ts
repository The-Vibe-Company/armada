import { appendFile } from "node:fs/promises";

type AdmissionEnvironment = Record<string, string | undefined>;
type AdmissionIO = {
  fetch: typeof fetch;
  now: () => number;
  out: (message: string) => void;
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Admit at most one ordinary full-smoke attempt per interval, including failed attempts. */
export async function stageSmokeAdmission(env: AdmissionEnvironment, io: AdmissionIO): Promise<boolean> {
  const interval = env.STAGING_SMOKE_INTERVAL_MINUTES ?? "30";
  if (!/^\d+$/.test(interval) || Number(interval) < 1 || Number(interval) > 1440) {
    throw new Error("Invalid staging smoke admission configuration");
  }
  // Publishing releases must always prove their exact commit, independently of main's cadence.
  if (env.SMOKE_RELEASE_GATE === "true") return true;

  const scheduled = env.SMOKE_SCHEDULED === "true";
  if (scheduled && (!env.GITHUB_SHA || !/^[a-fA-F0-9]{40}$/.test(env.GITHUB_SHA))) {
    throw new Error("Invalid staging smoke admission configuration");
  }
  const repository = env.GH_REPO;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !env.GH_TOKEN) {
    throw new Error("Invalid staging smoke admission configuration");
  }
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GH_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const read = async (path: string): Promise<unknown> => {
    const response = await io.fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("GitHub request failed");
    return response.json();
  };
  try {
    const result = await read("actions/artifacts?name=staging-full-smoke-slot&per_page=100");
    if (!object(result) || !Array.isArray(result.artifacts)) throw new Error("Invalid artifacts");
    let latest: { createdAt: number; runId: number; headSha: unknown } | undefined;
    for (const artifact of result.artifacts) {
      if (!object(artifact) || typeof artifact.expired !== "boolean") throw new Error("Invalid artifact");
      if (artifact.expired) continue;
      const run = artifact.workflow_run;
      if (
        !object(run) ||
        !Number.isSafeInteger(run.repository_id) ||
        !Number.isSafeInteger(run.head_repository_id) ||
        typeof run.head_branch !== "string"
      ) {
        throw new Error("Invalid artifact origin");
      }
      if (run.head_repository_id !== run.repository_id || run.head_branch !== "main") continue;
      if (typeof artifact.created_at !== "string" || !Number.isSafeInteger(run.id) || Number(run.id) <= 0) {
        throw new Error("Invalid artifact slot");
      }
      const createdAt = Date.parse(artifact.created_at);
      if (!Number.isFinite(createdAt)) throw new Error("Invalid artifact time");
      if (!latest || createdAt > latest.createdAt) {
        latest = { createdAt, runId: Number(run.id), headSha: run.head_sha };
      }
    }
    if (!latest) return true;
    const producer = await read(`actions/runs/${latest.runId}`);
    if (
      !object(producer) ||
      !object(producer.head_repository) ||
      producer.head_repository.full_name !== repository ||
      producer.head_branch !== "main" ||
      (producer.event !== "push" && producer.event !== "workflow_dispatch" && producer.event !== "schedule") ||
      (producer.path !== ".github/workflows/staging-gated-production.yml" &&
        producer.path !== ".github/workflows/post-deploy-smoke.yml")
    ) {
      throw new Error("Invalid staging smoke artifact producer");
    }
    const now = io.now();
    if (!Number.isFinite(now) || latest.createdAt > now) throw new Error("Invalid clock");
    if (scheduled) {
      if (typeof latest.headSha !== "string" || !/^[a-fA-F0-9]{40}$/.test(latest.headSha)) {
        throw new Error("Invalid staging smoke artifact commit");
      }
      if (latest.headSha.toLowerCase() === env.GITHUB_SHA?.toLowerCase()) {
        io.out("not-run(already-attempted)");
        return false;
      }
    }
    if (now - latest.createdAt < Number(interval) * 60_000) {
      io.out("not-run(cadence)");
      return false;
    }
    return true;
  } catch {
    // Never include request errors or response bodies: either can contain credentials.
    throw new Error("Unable to verify staging smoke admission evidence");
  }
}

if (import.meta.main) {
  try {
    const run = await stageSmokeAdmission(process.env, { fetch, now: Date.now, out: console.log });
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    await appendFile(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  } catch {
    console.error("Staging smoke admission failed; no compute is authorized");
    process.exitCode = 1;
  }
}
