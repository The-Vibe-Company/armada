import picomatch from "picomatch";
import { shellWord } from "./brief.ts";
import type { DeployTarget } from "./config.ts";

/** Only complete changed-file coverage can prove a scoped target unaffected. */
export function selectDeployTargets(
  targets: readonly DeployTarget[],
  branch: string,
  coverage: { files: string[] | null; filesComplete: boolean },
): { targets: string[]; skipped: string[] } {
  const selected: string[] = [];
  const skipped: string[] = [];
  for (const target of targets) {
    if (target.branch !== null && target.branch !== branch) continue;
    const matches = target.paths ? picomatch(target.paths, { dot: true }) : null;
    if (matches && coverage.files !== null && coverage.filesComplete && !coverage.files.some((file) => matches(file)))
      skipped.push(target.name);
    else selected.push(target.name);
  }
  return { targets: selected, skipped };
}

/** Required variables are non-secret machine settings; blanks mean unconfigured. */
export function resolveDeployEnv(
  target: DeployTarget,
  local: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): { env: Record<string, string>; missing: string[] } {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of target.requiresEnv ?? []) {
    const value = Object.hasOwn(local, name)
      ? local[name]
      : Object.hasOwn(processEnv, name)
        ? processEnv[name]
        : undefined;
    if (value?.trim()) env[name] = value;
    else missing.push(name);
  }
  return { env, missing };
}

export const DEPLOY_STATES = [
  "waiting",
  "live",
  "healthy",
  "deploy-failed",
  "smoke-failed",
  "timeout",
  "skipped",
  "not-runnable",
  "not-deployed",
] as const;
export type DeployState = (typeof DEPLOY_STATES)[number];
/** Config lives on the CLI; a server notice supplies both safe recovery commands. */
export const deployRetryLine = (target: string, redeploy?: boolean): string => {
  const command = `armada deploy retry ${shellWord(target)}`;
  return `Retry: ${command}${redeploy === false ? " --no-redeploy" : ` (or ${command} --no-redeploy to recheck)`}`;
};
export interface DeployRetryInput {
  target: string;
  sha?: string;
}
export class DeployRetryRefusal extends Error {
  constructor(
    message: string,
    readonly next = "armada deploy status",
  ) {
    super(message);
  }
}
/** A waiting attempt is resumed with reads only, never another host creation. */
export function assertDeployRetry(row: DeployRecord): void {
  if (row.state === "waiting" || row.state === "live")
    throw new DeployRetryRefusal(
      `a retry is already watching (attempt ${row.attempt} since ${row.startedAt})`,
      `armada deploy watch --sha ${row.sha} --target ${shellWord(row.target)} --attempt ${row.attempt}`,
    );
  if (row.state === "healthy") throw new DeployRetryRefusal("already healthy");
  if (!deployFailed(row.state)) throw new DeployRetryRefusal(`cannot retry ${row.state}; no failed deploy`);
}
export interface DeployInput {
  attempt?: number;
  target: string;
  sha: string;
  state: DeployState;
  detail: string;
  pauseOnFailure: boolean;
  liveSha?: string | null;
  coveredShas?: string[];
}
export interface DeployRecord extends DeployInput {
  attempt: number;
  project: string;
  startedAt: string;
  updatedAt: string;
  /** Server-assigned ordering, advanced when a failed deploy is retried. */
  sequence: number;
}
export interface DeployQuery {
  target?: string;
  sha?: string;
}
export const deployFailed = (state: DeployState) => ["deploy-failed", "smoke-failed", "timeout"].includes(state);
/** Last 30 lines and at most 4 KiB of UTF-8, without splitting a code point. */
export function deployDetail(output: string): string {
  const lines = output.trim().split("\n").slice(-30).join("\n");
  let size = 0;
  const tail: string[] = [];
  for (const ch of Array.from(lines).reverse()) {
    size += new TextEncoder().encode(ch).length;
    if (size > 4096) break;
    tail.push(ch);
  }
  return tail.reverse().join("");
}
export interface LiveDeploy {
  createdAt?: string;
  sha: string | null;
  state: "pending" | "success" | "failure" | "error" | "skipped";
  detail: string;
  notRunnable?: boolean;
}

/** The shell adapter classifies configuration errors and redacts detail before interpretation. */
export function checkReading(
  result: {
    code: number;
    stdout: string;
    detail: string;
    timedOut?: boolean;
    outputExceeded?: boolean;
    notRunnable?: boolean;
  },
  sha: string,
): LiveDeploy {
  const pending: LiveDeploy = { sha: null, state: "pending", detail: result.detail };
  if (result.notRunnable) return { ...pending, notRunnable: true };
  if (result.timedOut) return { ...pending, detail: "check timed out" };
  if (result.outputExceeded) return { ...pending, detail: "check output exceeded limit" };
  const last = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";
  const reportedSha = /^[0-9a-f]{40}$/i.test(last) ? last.toLowerCase() : sha;
  if (result.code === 0 || result.code === 1)
    return { sha: reportedSha, state: result.code === 0 ? "success" : "failure", detail: result.detail };
  if (result.code === 2)
    return last.startsWith("skipped")
      ? { ...pending, state: "skipped", detail: last.slice("skipped".length).replace(/^[:\s]+/, "") }
      : pending;
  return { ...pending, detail: `check exited ${result.code}; the contract is 0 live, 1 failed, 2 pending or skipped` };
}

export interface WatchDeployOptions {
  target: DeployTarget;
  sha: string;
  startedAt?: Date;
  attempt?: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  live: (remainingMs: number) => Promise<LiveDeploy>;
  /** Already verified live commits let overlapping watchers finish without another hosting read. */
  healthy?: () => Promise<{ sha: string; detail: string } | null>;
  includes: (base: string, head: string) => Promise<boolean>;
  /** Null means another watcher owns the smoke lease; read again next poll. */
  smoke: (
    liveSha: string,
    remainingMs: number,
  ) => Promise<{ ok: boolean | null; detail: string; notRunnable?: boolean }>;
  record: (input: DeployInput) => Promise<unknown>;
}

/** Pure deploy polling; clocks, hosting reads, shell commands and writes are injected. */
export async function watchDeploy(o: WatchDeployOptions): Promise<DeployState> {
  const deadline = (o.startedAt ?? o.now()).getTime() + o.target.timeoutMinutes * 60_000;
  let detail = "waiting for the merge commit";
  let liveSha: string | null = null;
  const record = (state: DeployState) =>
    o.record({
      target: o.target.name,
      attempt: o.attempt ?? 1,
      sha: o.sha,
      state,
      detail: deployDetail(detail),
      pauseOnFailure: state !== "not-runnable" && state !== "not-deployed" && o.target.pauseOnFailure,
      liveSha,
    });
  await record("waiting");
  while (o.now().getTime() < deadline) {
    if (o.healthy) {
      let verified: { sha: string; detail: string } | null = null;
      try {
        verified = await o.healthy();
      } catch {
        detail = "could not read shared deploy state; retrying";
      }
      if (verified) {
        liveSha = verified.sha;
        detail = verified.detail;
        await record("healthy");
        return "healthy";
      }
    }
    let live: LiveDeploy | null = null;
    try {
      live = await o.live(deadline - o.now().getTime());
    } catch {
      detail = "could not read the deploy status; retrying";
    }
    if (live) {
      detail = live.detail;
      liveSha = live.sha;
      if (live.notRunnable) {
        await record("not-runnable");
        return "not-runnable";
      }
      if (live.state === "skipped") {
        await record("not-deployed");
        return "not-deployed";
      }
      let includes = live.sha === o.sha;
      if (live.sha && !includes) {
        try {
          includes = await o.includes(o.sha, live.sha);
        } catch {
          detail = `${detail}\ncould not compare the live commit; retrying`;
        }
      }
      if (!includes && live.sha && live.state === "success" && o.target.check)
        detail = `check reported live ${live.sha}, which does not contain ${o.sha}`;
      if (includes && (live.state === "failure" || live.state === "error")) {
        await record("deploy-failed");
        return "deploy-failed";
      }
      if (includes && live.sha && live.state === "success" && o.now().getTime() < deadline) {
        await record("live");
        let result: { ok: boolean | null; detail: string; notRunnable?: boolean };
        try {
          result = await o.smoke(live.sha, deadline - o.now().getTime());
        } catch {
          result = { ok: null, detail: "could not read or record shared smoke state; retrying" };
        }
        detail = result.detail;
        if (result.notRunnable) {
          await record("not-runnable");
          return "not-runnable";
        }
        if (result.ok !== null) {
          const state = result.ok ? "healthy" : "smoke-failed";
          await record(state);
          return state;
        }
      }
    }
    await record("waiting");
    await o.sleep(Math.min(30_000, Math.max(0, deadline - o.now().getTime())));
  }
  detail = `deploy deadline reached\n${detail}`;
  await record("timeout");
  return "timeout";
}

export function deployLine(row: DeployRecord, now: Date): string {
  const age = Math.max(0, Math.floor((now.getTime() - Date.parse(row.updatedAt)) / 60_000));
  return `${row.target}: ${row.state === "not-deployed" ? `not deployed (host skipped: ${row.detail})` : row.state === "skipped" ? "skipped (not configured on this machine)" : row.state === "not-runnable" ? "not runnable (configuration)" : row.state} ${row.sha}${row.state === "waiting" || row.state === "live" ? ` — watching since ${row.startedAt.slice(11, 16)}, no news for ${age} min${age >= 2 ? "; watcher may have stopped" : ""}` : ""}`;
}
