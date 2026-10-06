import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  type ArmadaConfig,
  type Credentials,
  type DeployInput,
  type DeployRecord,
  deployDetail,
  deployLine,
  fetchLiveDeploy,
  fetchShaComparison,
  type MergeHold,
  machinePaths,
  processAlive,
  releaseWatchLock,
  shellWord,
  takeWatchLock,
  watchDeploy,
} from "@armada/core";
import { httpOptions, type Io, UsageError } from "./io.ts";
import { liveFleet } from "./worker.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("base64url");
const sleepOf = (io: Io) => io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Cleanup writes have the merge cleanup's bounded 2 s / 4 s retry schedule. */
export async function recordDeploy(io: Io, write: (input: DeployInput) => Promise<DeployRecord>, input: DeployInput) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write(input);
    } catch {
      const wait = [2000, 4000][attempt];
      if (wait === undefined) throw new Error("could not record deploy state in Armada after retries");
      await sleepOf(io)(wait);
    }
  }
}

export async function deployStatus(io: Io, config: ArmadaConfig, credentials: Credentials) {
  if (!config.deploy?.targets.length) return { rows: [] as DeployRecord[], holds: [] as MergeHold[] };
  const { fleet, warning } = liveFleet(io, config, credentials);
  if (!fleet) throw new UsageError(warning ?? "deploy status needs Armada sign-in", "armada login");
  const [rows, holds] = await Promise.all([fleet.deployState(), fleet.holds()]);
  return { rows, holds: holds.filter((h) => h.kind === "deploy") };
}

export async function startDeploys(
  io: Io,
  config: ArmadaConfig,
  _credentials: Credentials,
  configPath: string,
  sha: string | null,
  targets: string[],
  json: boolean,
) {
  const results: { target: string; started: boolean; next: string | null }[] = [];
  for (const name of targets) {
    const target = config.deploy?.targets.find((t) => t.name === name);
    if (!target) continue;
    const args = ["deploy", "watch", "--sha", sha ?? "<merge-sha>", "--target", name, "--config", configPath];
    const next = `armada ${args.map(shellWord).join(" ")}`;
    let started = false;
    try {
      const paths = machinePaths(io.env);
      started =
        (sha
          ? await io.startBackground?.(
              args,
              paths
                ? { logPath: join(paths.dir, "watch", `deploy-${hash(`${config.project.slug}/${name}/${sha}`)}.log`) }
                : undefined,
            )
          : false) ?? false;
    } catch {}
    results.push({ target: name, started, next: started ? null : next });
    if (!json) io.stdout(started ? `Watching the deploy of ${sha} to ${name}\n` : `Next: ${next}\n`);
  }
  return results;
}

export async function deploy(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: { rest: string[]; options: Record<string, string>; json: boolean },
  configPath: string,
): Promise<number> {
  const [action, ...extra] = args.rest;
  if (extra.length) throw new UsageError("deploy takes watch or status");
  if (action === "status") {
    if (Object.keys(args.options).length) throw new UsageError("deploy status only takes --json");
    const result = await deployStatus(io, config, credentials);
    io.stdout(
      args.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${
            result.rows
              .map((row) => deployLine(row, (io.now ?? (() => new Date()))()))
              .concat(result.holds.map((h) => `Hold #${h.id}: ${h.reason}`))
              .join("\n") || "No deploys recorded."
          }\n`,
    );
    return 0;
  }
  if (action !== "watch")
    throw new UsageError("use armada deploy status or armada deploy watch --sha <sha> --target <name>");
  if (args.json) throw new UsageError("deploy watch does not take --json");
  const sha = args.options.sha ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new UsageError("--sha must be a full 40-character commit SHA");
  const target = config.deploy?.targets.find((t) => t.name === args.options.target);
  if (!target) throw new UsageError("--target must name a declared deploy target");
  const { fleet, warning } = liveFleet(io, config, credentials);
  if (!fleet || credentials.armadaSignIn?.kind === "worker")
    throw new UsageError(warning ?? "deploy watch needs an organization sign-in", "armada login");
  const paths = machinePaths(io.env);
  if (!paths) throw new UsageError("deploy watch needs HOME or XDG_CONFIG_HOME for its PID file");
  if (!io.exec) throw new UsageError("deploy watch needs to run shell commands");
  if (!credentials.githubToken && target.githubEnvironment)
    throw new UsageError("a GitHub deploy target needs a GitHub token", "gh auth login");
  const pid = io.pid ?? process.pid;
  const lockName = `deploy-${hash(`${config.project.slug}/${target.name}/${sha}`)}`;
  const lock = await takeWatchLock(paths, lockName, pid, io.processAlive ?? processAlive);
  if (!lock.taken) {
    io.backgroundReady?.(true);
    return 0;
  }
  const now = io.now ?? (() => new Date());
  const ancestry = new Map<string, boolean>();
  const includes = async (base: string, head: string): Promise<boolean> => {
    if (base === head) return true;
    const key = `${base}/${head}`;
    const cached = ancestry.get(key);
    if (cached !== undefined) return cached;
    const answer = credentials.githubToken
      ? await fetchShaComparison({
          token: credentials.githubToken,
          repository: config.github.repository,
          ...httpOptions(io),
          base,
          head,
        })
      : (
          await io.exec?.("git", ["merge-base", "--is-ancestor", base, head], {
            cwd: dirname(configPath),
            timeoutMs: 10_000,
          })
        )?.code === 0;
    if (credentials.githubToken || answer) ancestry.set(key, answer);
    return answer;
  };
  const write = (input: DeployInput) =>
    recordDeploy(
      io,
      async (candidate) => {
        if (candidate.state === "healthy" && candidate.liveSha) {
          candidate = { ...candidate, coveredShas: [] };
          for (const row of await fleet.deployState({ target: target.name })) {
            if (await includes(row.sha, candidate.liveSha as string)) candidate.coveredShas?.push(row.sha);
          }
        }
        return fleet.recordDeploy(candidate);
      },
      input,
    );
  const holder = `deploy-${randomUUID()}`;
  const cwd = dirname(configPath);
  const command = async (command: string, liveSha: string, remainingMs: number) => {
    const result = await io.exec?.("sh", ["-c", command], {
      cwd,
      timeoutMs: Math.max(1, Math.min(remainingMs, 60_000)),
      maxOutputBytes: 64 * 1024,
      killTree: true,
      env: { ...io.env, ARMADA_DEPLOY_SHA: liveSha, ARMADA_DEPLOY_TARGET: target.name },
    });
    return {
      ok: result?.code === 0 && !result.timedOut,
      detail: deployDetail(
        `${result?.stdout ?? ""}\n${result?.stderr ?? ""}\n${result?.timedOut ? "command timed out" : `exit ${result?.code ?? 1}`}`,
      ),
      stdout: result?.stdout ?? "",
    };
  };
  const gh = { token: credentials.githubToken ?? "", repository: config.github.repository, ...httpOptions(io) };
  const smoke = async (liveSha: string, remainingMs: number) => {
    const existing = (await fleet.deployState({ target: target.name, sha: liveSha }))[0];
    if (existing?.state === "healthy" || existing?.state === "smoke-failed")
      return { ok: existing.state === "healthy", detail: existing.detail };
    const lease = {
      name: `deploy-smoke:${hash(`${target.name}/${liveSha}`)}`,
      holder,
      ttlMs: 5 * 60_000,
    };
    if (!(await fleet.acquireLease(lease)).acquired) return { ok: null, detail: "another watcher is running smoke" };
    try {
      const ready = (await fleet.deployState({ target: target.name, sha: liveSha }))[0];
      if (ready?.state === "healthy" || ready?.state === "smoke-failed")
        return { ok: ready.state === "healthy", detail: ready.detail };
      let result: { ok: boolean; detail: string };
      try {
        result = target.smoke
          ? await command(target.smoke, liveSha, remainingMs)
          : { ok: true, detail: "deploy live; no smoke command declared" };
      } catch {
        result = { ok: false, detail: "could not run the smoke command" };
      }
      // Publish the shared smoke result before slower ancestry/recovery reads.
      await recordDeploy(io, fleet.recordDeploy, {
        target: target.name,
        sha: liveSha,
        liveSha,
        state: result.ok ? "healthy" : "smoke-failed",
        detail: result.detail,
        pauseOnFailure: target.pauseOnFailure,
      });
      return result;
    } finally {
      try {
        await fleet.releaseLease(lease);
      } catch {
        // The result is durable; the lease expires without masking that result.
        io.stderr("armada: could not release deploy smoke lease; it will expire\n");
      }
    }
  };
  try {
    const prior = (await fleet.deployState({ target: target.name, sha }))[0];
    if (prior && !["waiting", "live"].includes(prior.state)) {
      io.backgroundReady?.(true);
      io.stdout(`${target.name}: ${prior.state}\n`);
      return prior.state === "healthy" ? 0 : 1;
    }
    await write({
      target: target.name,
      sha,
      state: "waiting",
      detail: "watching deploy",
      pauseOnFailure: target.pauseOnFailure,
    });
    io.backgroundReady?.(true);
    const result = await watchDeploy({
      target,
      sha,
      ...(prior ? { startedAt: new Date(prior.startedAt) } : {}),
      now,
      sleep: sleepOf(io),
      record: write,
      smoke,
      includes,
      healthy: async () => {
        for (const row of await fleet.deployState({ target: target.name })) {
          if (
            row.state === "healthy" &&
            (row.coveredShas?.includes(sha) || (await includes(sha, row.liveSha ?? row.sha)))
          )
            return { sha: row.liveSha ?? row.sha, detail: row.detail };
        }
        return null;
      },
      live: async (remainingMs) => {
        if (target.githubEnvironment) return fetchLiveDeploy({ ...gh, environment: target.githubEnvironment });
        const result = await command(target.liveShaCommand as string, sha, remainingMs);
        const liveSha = result.stdout.trim();
        return {
          sha: result.ok && /^[0-9a-f]{40}$/.test(liveSha) ? liveSha : null,
          state: result.ok && /^[0-9a-f]{40}$/.test(liveSha) ? "success" : "pending",
          detail: result.detail,
        };
      },
    });
    io.stdout(`${target.name}: ${result}\n`);
    return result === "healthy" ? 0 : 1;
  } catch (err) {
    io.backgroundReady?.(false);
    io.stderr(`armada: deploy watcher failed: ${err instanceof Error ? err.message : "unexpected failure"}\n`);
    return 1;
  } finally {
    await releaseWatchLock(paths, lockName, pid);
  }
}
