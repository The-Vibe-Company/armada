import picomatch from "picomatch";
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

export const DEPLOY_STATES = ["waiting", "live", "healthy", "deploy-failed", "smoke-failed", "timeout"] as const;
export type DeployState = (typeof DEPLOY_STATES)[number];
export interface DeployInput {
  target: string;
  sha: string;
  state: DeployState;
  detail: string;
  pauseOnFailure: boolean;
  liveSha?: string | null;
  coveredShas?: string[];
}
export interface DeployRecord extends DeployInput {
  project: string;
  startedAt: string;
  updatedAt: string;
  /** Server-assigned ordering of first observations, preserved on retries. */
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
  sha: string | null;
  state: "pending" | "success" | "failure" | "error";
  detail: string;
}

export interface WatchDeployOptions {
  target: DeployTarget;
  sha: string;
  startedAt?: Date;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  live: (remainingMs: number) => Promise<LiveDeploy>;
  /** Already verified live commits let overlapping watchers finish without another hosting read. */
  healthy?: () => Promise<{ sha: string; detail: string } | null>;
  includes: (base: string, head: string) => Promise<boolean>;
  /** Null means another watcher owns the smoke lease; read again next poll. */
  smoke: (liveSha: string, remainingMs: number) => Promise<{ ok: boolean | null; detail: string }>;
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
      sha: o.sha,
      state,
      detail: deployDetail(detail),
      pauseOnFailure: o.target.pauseOnFailure,
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
      let includes = live.sha === o.sha;
      if (live.sha && !includes) {
        try {
          includes = await o.includes(o.sha, live.sha);
        } catch {
          detail = `${detail}\ncould not compare the live commit; retrying`;
        }
      }
      if (includes && (live.state === "failure" || live.state === "error")) {
        await record("deploy-failed");
        return "deploy-failed";
      }
      if (includes && live.sha && live.state === "success" && o.now().getTime() < deadline) {
        await record("live");
        let result: { ok: boolean | null; detail: string };
        try {
          result = await o.smoke(live.sha, deadline - o.now().getTime());
        } catch {
          result = { ok: null, detail: "could not read or record shared smoke state; retrying" };
        }
        detail = result.detail;
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
  return `${row.target}: ${row.state} ${row.sha}${row.state === "waiting" || row.state === "live" ? ` — watching since ${row.startedAt.slice(11, 16)}, no news for ${age} min${age >= 2 ? "; watcher may have stopped" : ""}` : ""}`;
}
