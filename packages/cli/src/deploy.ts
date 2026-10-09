import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  type ArmadaConfig,
  type Credentials,
  checkReading,
  type DeployInput,
  type DeployRecord,
  type DeployTarget,
  deployDetail,
  deployLine,
  deployRetryLine,
  fetchLiveDeploy,
  fetchShaComparison,
  type MergeHold,
  machinePaths,
  processAlive,
  readDeployEnv,
  redactSecrets,
  releaseWatchLock,
  resolveDeployEnv,
  shellWord,
  takeWatchLock,
  watchDeploy,
} from "@armada/core";
import { type ExecResult, httpOptions, type Io, UsageError } from "./io.ts";
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

/** Report a local configuration skip before any command or background watcher runs. */
async function skipUnconfigured(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  target: DeployTarget,
  sha: string | null,
  missing: string[],
) {
  io.stderr(`armada: ${target.name}: deploy check skipped: ${missing.join(", ")} not set on this machine\n`);
  const { fleet } = liveFleet(io, config, credentials);
  if (sha && fleet) {
    try {
      await recordDeploy(io, fleet.recordDeploy, {
        target: target.name,
        sha,
        state: "skipped",
        detail: `skipped (not configured on this machine): ${missing.join(", ")}`,
        pauseOnFailure: false,
      });
    } catch {
      io.stderr("armada: could not record skipped deploy state\n");
    }
  }
}

export async function startDeploys(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  configPath: string,
  sha: string | null,
  targets: string[],
  json: boolean,
) {
  const results: { target: string; started: boolean; next: string | null; skipped?: boolean }[] = [];
  const local = await readDeployEnv(machinePaths(io.env), config.project.slug);
  if (local.warning) io.stderr(`armada: ${local.warning}\n`);
  for (const name of targets) {
    const target = config.deploy?.targets.find((t) => t.name === name);
    if (!target) continue;
    const { missing, env } = resolveDeployEnv(target, local.env, io.env);
    if (missing.length) {
      await skipUnconfigured(io, config, credentials, target, sha, missing);
      results.push({ target: name, started: false, next: null, skipped: true });
      continue;
    }
    const args = ["deploy", "watch", "--sha", sha ?? "<merge-sha>", "--target", name, "--config", configPath];
    const next = `armada ${args.map(shellWord).join(" ")}`;
    let started = false;
    try {
      const paths = machinePaths(io.env);
      started =
        (sha
          ? await io.startBackground?.(args, {
              env: { ...io.env, ...env },
              ...(paths
                ? { logPath: join(paths.dir, "watch", `deploy-${hash(`${config.project.slug}/${name}/${sha}`)}.log`) }
                : {}),
            })
          : false) ?? false;
    } catch {}
    results.push({ target: name, started, next: started ? null : next });
    const note = target.smoke ? "" : " (no smoke command: a live but broken service reads healthy)";
    if (!json) io.stdout(started ? `Watching the deploy of ${sha} to ${name}${note}\n` : `Next: ${next}\n`);
  }
  return results;
}

/** A redeploy creates host work: run it once, then observe using reads only. */
async function retryDeploy(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  target: DeployTarget,
  noRedeploy: boolean,
  configPath: string,
): Promise<number> {
  const { fleet, warning } = liveFleet(io, config, credentials);
  if (!fleet || credentials.armadaSignIn?.kind === "worker")
    throw new UsageError(warning ?? "deploy retry needs an organization sign-in", "armada login");
  const paths = machinePaths(io.env);
  const local = await readDeployEnv(paths, config.project.slug);
  if (local.warning) io.stderr(`armada: ${local.warning}\n`);
  const settings = resolveDeployEnv(target, local.env, io.env);
  if (settings.missing.length)
    throw new UsageError(
      `deploy retry needs ${settings.missing.join(", ")}`,
      settings.missing.map((name) => `armada config set deploy.env.${name} <value>`).join("; "),
    );
  if (target.redeploy && !noRedeploy && !io.exec) throw new UsageError("deploy retry needs to run shell commands");
  if (target.githubEnvironment && !credentials.githubToken)
    throw new UsageError("a GitHub deploy target needs a GitHub token", "gh auth login");
  const row = await fleet.retryDeploy({ target: target.name });
  const secrets = [
    credentials.armadaSignIn?.kind === "api-key" ? credentials.armadaSignIn.key : credentials.armadaSignIn?.token,
    credentials.linearApiKey,
    credentials.githubToken,
    ...config.secrets.names.map((name) => io.env[name]),
    ...Object.values(settings.env),
  ].filter((value): value is string => !!value);
  const clean = (text: string) => redactSecrets(text, secrets);
  let since: string | undefined;
  if (target.redeploy && !noRedeploy) {
    since = (io.now ?? (() => new Date()))().toISOString();
    let result: ExecResult | undefined;
    try {
      result = await io.exec?.("sh", ["-c", target.redeploy], {
        cwd: dirname(configPath),
        timeoutMs: 120_000,
        maxOutputBytes: 64 * 1024,
        processGroup: true,
        env: { ...io.env, ...settings.env, ARMADA_DEPLOY_SHA: row.sha, ARMADA_DEPLOY_TARGET: target.name },
      });
    } catch {
      io.stdout("redeploy outcome unknown; check the host; it is not run again\n");
    }
    if (result?.timedOut || result?.outputExceeded)
      io.stdout("redeploy outcome unknown; check the host; it is not run again\n");
    else if (result && result.code !== 0) {
      const detail = deployDetail(clean(`${result.stdout}\n${result.stderr}\nredeploy command exited ${result.code}`));
      await recordDeploy(io, fleet.recordDeploy, {
        target: target.name,
        sha: row.sha,
        attempt: row.attempt,
        state: "deploy-failed",
        detail,
        pauseOnFailure: target.pauseOnFailure,
      });
      io.stdout(`Result: not retried (redeploy command exited ${result.code})\n${detail}\n`);
      return 1;
    }
  } else if (!target.redeploy) io.stdout(`No redeploy command for ${target.name}: rechecking what is live now.\n`);
  const args = [
    "deploy",
    "watch",
    "--sha",
    row.sha,
    "--target",
    target.name,
    "--attempt",
    String(row.attempt),
    ...(since ? ["--since", since] : []),
    "--config",
    configPath,
  ];
  let started = false;
  try {
    started =
      (await io.startBackground?.(args, {
        env: { ...io.env, ...settings.env },
        ...(paths
          ? {
              logPath: join(
                paths.dir,
                "watch",
                `deploy-${hash(`${config.project.slug}/${target.name}/${row.sha}/${row.attempt}`)}.log`,
              ),
            }
          : {}),
      })) ?? false;
  } catch {}
  io.stdout(
    started
      ? `Watching the retry of ${row.sha} on ${target.name} (attempt ${row.attempt})\n`
      : `Next: armada ${args.map(shellWord).join(" ")}\n`,
  );
  return 0;
}

export async function deploy(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: { rest: string[]; options: Record<string, string>; json: boolean },
  configPath: string,
): Promise<number> {
  const [action, ...extra] = args.rest;
  if (action === "retry") {
    if (extra.length !== 1 || args.json || Object.keys(args.options).some((key) => key !== "no-redeploy"))
      throw new UsageError("armada deploy retry <target> [--no-redeploy]");
    const target = config.deploy?.targets.find((t) => t.name === extra[0]);
    if (!target) throw new UsageError("retry must name a declared deploy target");
    return retryDeploy(io, config, credentials, target, args.options["no-redeploy"] !== undefined, configPath);
  }
  if (extra.length) throw new UsageError("deploy takes retry, watch or status");
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
              .concat(
                result.rows
                  .filter(
                    (row) =>
                      ["deploy-failed", "smoke-failed", "timeout"].includes(row.state) ||
                      result.holds.some((h) => h.ref === row.target),
                  )
                  .map((row) => {
                    if (["not-runnable", "not-deployed", "skipped"].includes(row.state))
                      return `Next: armada deploy watch --sha ${row.sha} --target ${shellWord(row.target)} --attempt ${row.attempt}`;
                    return deployRetryLine(
                      row.target,
                      !!config.deploy?.targets.find((t) => t.name === row.target)?.redeploy,
                    );
                  }),
              )
              .join("\n") || "No deploys recorded."
          }\n`,
    );
    return 0;
  }
  if (action !== "watch")
    throw new UsageError(
      "use armada deploy retry <target>, armada deploy status or armada deploy watch --sha <sha> --target <name>",
    );
  if (args.json || args.options["no-redeploy"] !== undefined)
    throw new UsageError("deploy watch does not take --json or --no-redeploy");
  const attempt = Number(args.options.attempt ?? 1);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new UsageError("--attempt must be a positive integer");
  const since = args.options.since;
  if (since && (!/^\d{4}-\d{2}-\d{2}T/.test(since) || !Number.isFinite(Date.parse(since))))
    throw new UsageError("--since must be an ISO timestamp");
  const sha = args.options.sha ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new UsageError("--sha must be a full 40-character commit SHA");
  const target = config.deploy?.targets.find((t) => t.name === args.options.target);
  if (!target) throw new UsageError("--target must name a declared deploy target");
  const { fleet, warning } = liveFleet(io, config, credentials);
  if (!fleet || credentials.armadaSignIn?.kind === "worker")
    throw new UsageError(warning ?? "deploy watch needs an organization sign-in", "armada login");
  const paths = machinePaths(io.env);
  const local = await readDeployEnv(paths, config.project.slug);
  if (local.warning) io.stderr(`armada: ${local.warning}\n`);
  const settings = resolveDeployEnv(target, local.env, io.env);
  if (settings.missing.length) {
    await skipUnconfigured(io, config, credentials, target, sha, settings.missing);
    io.backgroundReady?.(true);
    return 0;
  }
  if (!paths) throw new UsageError("deploy watch needs HOME or XDG_CONFIG_HOME for its PID file");
  if (!io.exec) throw new UsageError("deploy watch needs to run shell commands");
  if (!credentials.githubToken && target.githubEnvironment)
    throw new UsageError("a GitHub deploy target needs a GitHub token", "gh auth login");
  const pid = io.pid ?? process.pid;
  const lockName = `deploy-${hash(`${config.project.slug}/${target.name}/${sha}/${attempt}`)}`;
  const lock = await takeWatchLock(paths, lockName, pid, io.processAlive ?? processAlive);
  if (!lock.taken) {
    io.backgroundReady?.(true);
    return 0;
  }
  const now = io.now ?? (() => new Date());
  const secrets = [
    credentials.armadaSignIn?.kind === "api-key" ? credentials.armadaSignIn.key : credentials.armadaSignIn?.token,
    credentials.linearApiKey,
    credentials.githubToken,
    ...config.secrets.names.map((name) => io.env[name]),
    ...Object.values(settings.env),
  ].filter((value): value is string => !!value);
  const clean = (text: string) => redactSecrets(text, secrets);
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
  let observationDetail = "";
  const write = (input: DeployInput) =>
    recordDeploy(
      io,
      async (candidate) => {
        observationDetail = clean(candidate.detail);
        if (candidate.state === "healthy" && candidate.liveSha) {
          candidate = { ...candidate, coveredShas: [] };
          for (const row of await fleet.deployState({ target: target.name })) {
            if (await includes(row.sha, candidate.liveSha as string)) candidate.coveredShas?.push(row.sha);
          }
        }
        return fleet.recordDeploy({ ...candidate, detail: clean(candidate.detail) });
      },
      input,
    );
  const holder = `deploy-${randomUUID()}`;
  const cwd = dirname(configPath);
  let configurationDetail = "";
  const command = async (command: string, liveSha: string, remainingMs: number) => {
    const result = await io
      .exec?.("sh", ["-c", command], {
        cwd,
        timeoutMs: Math.max(1, Math.min(remainingMs, 60_000)),
        maxOutputBytes: 64 * 1024,
        processGroup: true,
        env: {
          ...io.env,
          ...settings.env,
          ARMADA_DEPLOY_SHA: liveSha,
          ARMADA_DEPLOY_TARGET: target.name,
          ARMADA_DEPLOY_SINCE: since,
        },
      })
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
        return { code: 127, stdout: "", stderr: err.message, timedOut: false, outputExceeded: false };
      });
    const notRunnable =
      !!result &&
      !result.timedOut &&
      result.code !== 0 &&
      (result.code === 127 ||
        /(?:^|\n)[^\n]*(?:sh|bash|dash|zsh):[^\n]*(?:[A-Za-z_][A-Za-z0-9_]*: (?:set [A-Za-z_][A-Za-z0-9_]*|parameter (?:null or )?not set|unbound variable)|cd:[^\n]*(?:can't cd|cannot|No such file|not a directory))/i.test(
          result.stderr,
        ) ||
        [...command.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?\?/g)].some((match) =>
          result.stderr.includes(`${match[1]}:`),
        ));
    const detail = deployDetail(
      clean(
        `${result?.stdout ?? ""}\n${result?.stderr ?? ""}\n${result?.timedOut ? "command timed out" : `exit ${result?.code ?? 1}`}`,
      ),
    );
    if (notRunnable) configurationDetail = detail;
    return {
      code: result?.code ?? 1,
      timedOut: result?.timedOut ?? false,
      outputExceeded: result?.outputExceeded ?? false,
      ok: result?.code === 0 && !result.timedOut,
      detail,
      notRunnable,
      stdout: result?.stdout ?? "",
    };
  };
  const gh = { token: credentials.githubToken ?? "", repository: config.github.repository, ...httpOptions(io) };
  const cachedSmoke = (row: DeployRecord) =>
    row.state === "smoke-failed" ||
    (row.state === "healthy" && (!since || Date.parse(row.updatedAt) >= Date.parse(since)));
  const smoke = async (liveSha: string, remainingMs: number) => {
    const existing = (await fleet.deployState({ target: target.name, sha: liveSha }))[0];
    if (existing && cachedSmoke(existing)) return { ok: existing.state === "healthy", detail: existing.detail };
    const lease = {
      name: `deploy-smoke:${hash(`${target.name}/${liveSha}`)}`,
      holder,
      ttlMs: 5 * 60_000,
    };
    if (!(await fleet.acquireLease(lease)).acquired) return { ok: null, detail: "another watcher is running smoke" };
    try {
      const ready = (await fleet.deployState({ target: target.name, sha: liveSha }))[0];
      if (ready && cachedSmoke(ready)) return { ok: ready.state === "healthy", detail: ready.detail };
      let result: { ok: boolean; detail: string; notRunnable?: boolean };
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
        attempt: liveSha === sha ? attempt : (ready?.attempt ?? 1),
        liveSha,
        state: result.notRunnable ? "not-runnable" : result.ok ? "healthy" : "smoke-failed",
        detail: result.detail,
        pauseOnFailure: !result.notRunnable && target.pauseOnFailure,
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
    if (attempt > 1 && (!prior || prior.attempt < attempt))
      throw new UsageError("--attempt must name the current recorded deploy attempt", "armada deploy status");
    if (prior && prior.attempt > attempt) {
      io.backgroundReady?.(true);
      io.stdout(`${target.name}: attempt ${attempt} superseded by attempt ${prior.attempt}\n`);
      return 0;
    }
    if (
      prior &&
      prior.attempt === attempt &&
      !["waiting", "live", "skipped", "not-runnable", "not-deployed"].includes(prior.state)
    ) {
      io.backgroundReady?.(true);
      io.stdout(
        `${target.name}: ${prior.state}${prior.state === "healthy" ? "" : `; to recheck: armada deploy retry ${shellWord(target.name)} --no-redeploy`}\n`,
      );
      return prior.state === "healthy" ? 0 : 1;
    }
    await write({
      target: target.name,
      sha,
      state: "waiting",
      attempt,
      detail: "watching deploy",
      pauseOnFailure: target.pauseOnFailure,
    });
    io.backgroundReady?.(true);
    const result = await watchDeploy({
      target,
      sha,
      attempt,
      ...(prior && !["skipped", "not-runnable", "not-deployed"].includes(prior.state)
        ? { startedAt: new Date(prior.startedAt) }
        : {}),
      now,
      sleep: sleepOf(io),
      record: write,
      smoke,
      includes,
      healthy: async () => {
        for (const row of await fleet.deployState({ target: target.name })) {
          if (
            row.state === "healthy" &&
            (!since || Date.parse(row.updatedAt) >= Date.parse(since)) &&
            (row.coveredShas?.includes(sha) || (await includes(sha, row.liveSha ?? row.sha)))
          )
            return { sha: row.liveSha ?? row.sha, detail: row.detail };
        }
        return null;
      },
      live: async (remainingMs) => {
        if (target.githubEnvironment) return fetchLiveDeploy({ ...gh, environment: target.githubEnvironment, since });
        if (target.check) return checkReading(await command(target.check, sha, remainingMs), sha);
        const result = await command(target.liveShaCommand as string, sha, remainingMs);
        const liveSha = result.stdout.trim();
        return {
          sha: result.ok && /^[0-9a-f]{40}$/.test(liveSha) ? liveSha : null,
          state: result.ok && /^[0-9a-f]{40}$/.test(liveSha) ? "success" : "pending",
          detail: result.detail,
          notRunnable: result.notRunnable,
        };
      },
    });
    if (result === "not-runnable")
      io.stderr(
        `armada: warning: ${target.name}: deploy check not runnable on this machine (configuration)\n${configurationDetail}\n`,
      );
    io.stdout(
      `${target.name}: ${result === "not-deployed" ? `not deployed (host skipped: ${observationDetail})` : result === "not-runnable" ? "not runnable (configuration)" : result}\n`,
    );
    return result === "healthy" || result === "not-runnable" || result === "not-deployed" ? 0 : 1;
  } catch (err) {
    io.backgroundReady?.(false);
    io.stderr(`armada: deploy watcher failed: ${clean(err instanceof Error ? err.message : "unexpected failure")}\n`);
    return 1;
  } finally {
    await releaseWatchLock(paths, lockName, pid);
  }
}
