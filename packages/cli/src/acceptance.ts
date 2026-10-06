import {
  type ArmadaConfig,
  allowAcceptance,
  type Credentials,
  machinePaths,
  processAlive,
  projectOf,
  redactSecrets,
  releaseWatchLock,
  runAcceptance,
  takeWatchLock,
} from "@armada/core";
import { apiOf } from "./api.ts";
import { type Io, UsageError } from "./io.ts";
import { currentTicket, type WorkerArgs, withContext } from "./worker.ts";

export async function acceptance(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  a: WorkerArgs,
): Promise<number> {
  const [action, namedTicket, ...extra] = a.rest;
  if (extra.length || (action === "run" && namedTicket) || !["run", "allow"].includes(action ?? ""))
    throw new UsageError(
      "use armada acceptance run [--name <name>] [--ticket <ticket>] or acceptance allow <ticket> --runs <n> --reason <why>",
    );
  if (action === "run" && (a.options.runs !== undefined || a.options.reason !== undefined))
    throw new UsageError("--runs and --reason are for acceptance allow");
  if (action === "allow" && (!namedTicket || a.options.name !== undefined))
    throw new UsageError("acceptance allow needs a ticket; --name is for run");
  const ticket = currentTicket(io, config, namedTicket ?? a.options.ticket, credentials.workerTickets);
  if (action === "allow")
    return withContext(io, config, credentials, a.json, (ctx) =>
      allowAcceptance(ctx, {
        ticket,
        runs: Number(a.options.runs),
        reason: a.options.reason ?? "",
      }),
    );
  if (!io.exec) throw new UsageError("acceptance needs git and a local command runner");
  const exec = io.exec;
  const secrets = [
    credentials.linearApiKey,
    credentials.githubToken,
    ...Object.entries(io.env)
      .filter(([name]) => /key|token|secret|password|credential|auth|url|dsn|connection/i.test(name))
      .map(([, value]) => value),
  ].filter((v): v is string => !!v);
  const root = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: io.cwd, timeoutMs: 10_000 });
  if (root.code || !root.stdout.trim()) throw new UsageError("acceptance needs a git checkout");
  const cwd = root.stdout.trim();
  const checkHead = async (expected: string) => {
    const status = await exec("git", ["status", "--porcelain"], { cwd, timeoutMs: 10_000 });
    const head = await exec("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 10_000 });
    if (status.code || head.code || status.stdout.trim() || head.stdout.trim() !== expected)
      throw new UsageError(
        "acceptance needs a clean working tree and HEAD equal to the PR head; commit and push first",
      );
  };
  const paths = machinePaths(io.env);
  if (!paths) throw new UsageError("acceptance needs HOME or an absolute XDG_CONFIG_HOME for its local execution lock");
  const lock = `acceptance-${config.github.repository.replace(/[^a-zA-Z0-9-]/g, "-")}-${ticket.replace(/[^a-zA-Z0-9-]/g, "-")}`;
  const pid = io.pid ?? process.pid;
  const taken = await takeWatchLock(paths, lock, pid, io.processAlive ?? processAlive, undefined, undefined, false);
  if (!taken.taken)
    throw new UsageError(`acceptance is already running for ${ticket} on this machine; wait for it to finish`);
  let ok = true;
  try {
    // withContext prints normal report outcomes and preserves the existing live-data warning behavior.
    await withContext(io, config, credentials, a.json, async (ctx) => {
      const result = await runAcceptance(
        ctx,
        { ticket, ...(a.options.name !== undefined ? { name: a.options.name } : {}) },
        {
          checkHead,
          run: async (rule) => {
            let diagnosticsSafe = true;
            if (credentials.armadaSignIn) {
              try {
                const released = await apiOf(io, credentials.armadaApi.url).releaseSecrets(
                  credentials.armadaSignIn,
                  projectOf(config),
                  null,
                );
                secrets.push(...released.secrets.map((secret) => secret.value));
              } catch {
                // Nonsecret checks still run offline; unknown vault values never enter Linear diagnostics.
                diagnosticsSafe = false;
              }
            }
            try {
              const result = await exec("sh", ["-c", rule.command], {
                cwd,
                timeoutMs: rule.timeoutMinutes * 60_000,
                processGroup: true,
                maxOutputBytes: 4 * 1024 * 1024,
              });
              const detail = result.timedOut
                ? `\nTimed out after ${rule.timeoutMinutes} minutes.`
                : result.outputExceeded
                  ? "\nOutput exceeded the 4 MB limit."
                  : "";
              return {
                ok: result.code === 0 && !result.timedOut && !result.outputExceeded,
                output: diagnosticsSafe
                  ? redactSecrets(`${result.stdout}\n${result.stderr}`, secrets) + detail
                  : `Command failed; diagnostics withheld because project secret values could not be read for masking.${detail}`,
              };
            } catch {
              return { ok: false, output: "Command runner could not execute the acceptance check." };
            }
          },
        },
      );
      ok = result.ok;
      // Show all durable start and result reports in one response.
      return {
        ticket,
        url: result.outcomes.at(-1)?.url ?? "",
        lines: result.outcomes.length
          ? result.outcomes.flatMap((o) => o.lines)
          : ["No acceptance checks apply to this pull request."],
        warnings: [...new Set(result.outcomes.flatMap((o) => o.warnings))],
        inbox: result.outcomes.at(-1)?.inbox ?? null,
        state: result.outcomes.at(-1)?.state ?? null,
      };
    });
    return ok ? 0 : 1;
  } finally {
    await releaseWatchLock(paths, lock, pid);
  }
}
