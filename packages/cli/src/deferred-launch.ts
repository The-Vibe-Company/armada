import { resolve } from "node:path";
import {
  ArmadaApiError,
  type ArmadaConfig,
  BriefError,
  type Credentials,
  DEFERRED_LAUNCH_BACKOFF_MINUTES,
  type DeferredAttempt,
  type DeferredLaunch,
  type Fleet,
  type MergeOutcome,
  Refusal,
} from "@armada/core";
import { version } from "../package.json" with { type: "json" };
import { loadCredentials } from "./auth.ts";
import { type Io, UsageError } from "./io.ts";
import { LaunchError, launchWorker } from "./launch.ts";
import { redactRuntimeText } from "./runtimes/adapter.ts";
import { liveFleet } from "./worker.ts";
import { countWorkerSlots } from "./worker-slots.ts";

export interface DeferredLaunchResult {
  ticket: string;
  request: number;
  status: "launched" | "manual" | "failed";
  command: string;
  output?: string;
  title?: string;
  profile?: string;
}

const failureReason = (error: unknown) =>
  error instanceof UsageError ||
  error instanceof Refusal ||
  error instanceof BriefError ||
  error instanceof ArmadaApiError
    ? redactRuntimeText(error.message)
    : "the launcher could not complete; inspect the pending launch before retrying";

/** One scheduler for merge follow-ons and watch polls; admission remains server-owned. */
async function fireRequests(
  config: ArmadaConfig,
  fleet: Fleet,
  launch: (request: DeferredLaunch) => Promise<Pick<DeferredLaunchResult, "output" | "title" | "profile">>,
  options: {
    only?: string[];
    fresh?: MergeOutcome["unblocked"];
    limit?: number;
    slots?: () => Promise<{ taken: number }>;
    warning: (message: string) => void;
    unavailable?: () => void;
    failed?: (request: DeferredLaunch, error: unknown) => Promise<void>;
  },
): Promise<DeferredLaunchResult[]> {
  let requests: DeferredLaunch[];
  try {
    requests = await fleet.deferredLaunches();
  } catch {
    options.unavailable?.();
    options.warning("could not read deferred launch requests; run armada status to check waiting launches");
    return [];
  }
  const results: DeferredLaunchResult[] = [];
  let fired = 0;
  for (const request of requests.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id - b.id)) {
    if (options.only && !options.only.includes(request.ticket)) continue;
    const fresh = options.fresh?.ready.find((ticket) => ticket.id === request.ticket);
    if (
      !request.owned ||
      request.blockers === null ||
      (request.reason !== null && !(fresh && request.reason.startsWith("waits on ")))
    )
      continue;
    if (request.attempts === undefined || !request.createdAt) {
      options.warning(
        `${request.ticket}: deferred attempt metadata is unavailable; deploy the dashboard before the CLI`,
      );
      continue;
    }
    const profile = request.profile ? config.conductor.profiles[request.profile] : null;
    if (
      fresh?.readyForAgent === false ||
      request.guided ||
      (request.pinned !== false && profile?.runtime === "claude-code")
    ) {
      results.push({ ticket: request.ticket, request: request.id, status: "manual", command: request.command });
      continue;
    }
    if (options.limit !== undefined && fired >= options.limit) break;
    // Never let automatic launches use the urgent-priority bypass, either.
    if (config.policy.maxWorkers && options.slots) {
      try {
        if ((await options.slots()).taken >= config.policy.maxWorkers) break;
      } catch {
        options.unavailable?.();
        options.warning("could not read worker slots; no further waiting launches were started");
        break;
      }
    }
    let attempt: DeferredAttempt;
    try {
      attempt = await fleet.attemptDeferredLaunch({
        id: request.id,
        backoffMinutes: (request.attempts ?? 0) >= 2 ? 15 : DEFERRED_LAUNCH_BACKOFF_MINUTES,
      });
    } catch {
      options.unavailable?.();
      options.warning(`${request.ticket}: could not confirm deferred launch admission; nothing was launched`);
      break;
    }
    if (!attempt.ok) continue;
    fired++;
    const admitted = { ...request, attempts: attempt.attempt, attemptedAt: attempt.attemptedAt };
    try {
      if (!attempt.tokenFence || !attempt.attemptedAt) {
        options.unavailable?.();
        throw new UsageError("deferred token admission is unavailable; deploy the dashboard before the CLI");
      }
      results.push({
        ticket: request.ticket,
        request: request.id,
        status: "launched",
        command: request.command,
        ...(await launch(admitted)),
      });
    } catch (error) {
      await options.failed?.(admitted, error);
      options.warning(
        `${request.ticket} was not launched: ${failureReason(error)}. Request #${request.id} stays pending; ${request.command}`,
      );
      results.push({ ticket: request.ticket, request: request.id, status: "failed", command: request.command });
    }
  }
  return results;
}

export async function fireDeferredLaunches(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  options: {
    only?: string[];
    source: "merge" | "watch";
    configPath?: string;
    fresh?: MergeOutcome["unblocked"];
    warning?: (message: string) => void;
    unavailable?: () => void;
  },
): Promise<DeferredLaunchResult[]> {
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet) {
    options.unavailable?.();
    return [];
  }
  const warning = options.warning ?? ((message: string) => io.stderr(`armada: warning: ${message}\n`));
  try {
    return await fireRequests(
      config,
      fleet,
      async (request) => {
        const launchCredentials = (await loadCredentials(io, { project: config.project.slug })).credentials;
        const printed: string[] = [];
        const errors: string[] = [];
        const json = options.source === "watch";
        const code = await launchWorker(
          {
            ...io,
            interactive: false,
            stdout: (line) => printed.push(line),
            stderr: (line) => {
              errors.push(line);
              io.stderr(line);
            },
          },
          config,
          launchCredentials,
          { rest: [request.ticket], json, options: {} },
          version,
          options.configPath ?? resolve(io.cwd, "armada.toml"),
          undefined,
          request,
        );
        if (code !== 0 && !printed.length)
          throw new UsageError(
            redactRuntimeText(errors.join("").trim()) || "runtime preflight refused; install the required tools",
          );
        if (code !== 0)
          throw new LaunchError(
            "the launch is unconfirmed; inspect the worker before retrying",
            `armada peek ${request.ticket}`,
          );
        const output = printed.join("");
        if (!json) return { output };
        const result = JSON.parse(output) as { title: string; profile: string };
        return { title: result.title, profile: result.profile };
      },
      {
        ...options,
        warning,
        limit: options.source === "watch" ? 1 : undefined,
        slots: () => countWorkerSlots(io, fleet),
        failed: async (request, error) => {
          try {
            // Runtime recording is best-effort. Confirm its current notice
            // before assuming it can wake the coordinator; otherwise use the
            // same pending-generation/request-attempt fence as preflight.
            if (error instanceof LaunchError) {
              const notices = await fleet.ticketItems(request.ticket);
              if (
                notices.some(
                  (notice) =>
                    (notice.kind === "launch-failed" || notice.kind === "launch-uncertain") &&
                    notice.createdAt >= (request.attemptedAt ?? "\uffff"),
                )
              )
                return;
            }
            const pending = (await fleet.pendingLaunches()).find((launch) => launch.ticket === request.ticket);
            if (pending?.id) {
              await fleet.recordLaunchFailure({
                ticket: request.ticket,
                outcome: "uncertain",
                launchId: pending.id,
                reason: "deferred launch has a pending token after an interrupted launch; inspect before retrying",
                next: `armada peek ${request.ticket}`,
              });
              return;
            }
            await fleet.recordLaunchFailure({
              ticket: request.ticket,
              outcome: "failed",
              reason: failureReason(error),
              next:
                request.attempts === 3
                  ? `gave up after 3 failed launches; renew with armada launch ${request.ticket} --when-unblocked`
                  : request.command,
              requestId: request.id,
              attempt: request.attempts!,
              attemptedAt: request.attemptedAt ?? undefined,
            });
          } catch {
            options.unavailable?.();
            warning(`${request.ticket}: could not record the failed deferred launch on Armada`);
          }
        },
      },
    );
  } catch {
    options.unavailable?.();
    // In particular, a failed slot read is never permission to launch.
    warning("could not read worker slots; no further waiting launches were started");
    return [];
  }
}

/** A confirmed merge stays successful even if a requested follow-on launch fails. */
export async function launchDeferredAfterMerge(
  outcome: MergeOutcome,
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  configPath?: string,
): Promise<DeferredLaunchResult[]> {
  if (!outcome.merged || !outcome.ticket || !outcome.unblocked?.ready.length) return [];
  return fireDeferredLaunches(io, config, credentials, {
    source: "merge",
    only: outcome.unblocked.ready.map((ticket) => ticket.id),
    fresh: outcome.unblocked,
    configPath,
    warning: (message) => outcome.warnings.push(message),
  });
}
