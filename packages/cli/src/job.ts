// Local dispatch commands return quickly; the runner does the long work elsewhere.
import { dirname } from "node:path";
import {
  type ArmadaConfig,
  type Credentials,
  type Fleet,
  JOB_PROGRESS_MAX,
  JOB_REF_MAX,
  JOB_STATES,
  type Job,
  type JobConfig,
  type JobState,
  jobIsOpen,
  jobOverdue,
  lastJobLine,
  machinePaths,
  parseJobStatus,
  processAlive,
  readWatchState,
  releaseWatchLock,
  takeWatchLock,
  ticketOwners,
  updateWatchState,
} from "@armada/core";
import { type ExecResult, type Io, UsageError } from "./io.ts";
import { currentTicket, liveFleet } from "./worker.ts";

interface JobArgs {
  rest: string[];
  options: Record<string, string>;
  json: boolean;
}

function definition(config: ArmadaConfig, name: string): JobConfig {
  const job = Object.hasOwn(config.jobs ?? {}, name) ? config.jobs[name] : undefined;
  if (!job) throw new UsageError(`job ${name} is not configured in armada.toml`);
  return job;
}

export function renderJob(job: Job, config: ArmadaConfig, now: Date): string {
  const overdue = jobOverdue(job, config.jobs?.[job.name]?.maxHours, now);
  return (
    `Job ${job.id} · ${job.ticket} · ${job.name} · ${job.state}${overdue ? " · overdue" : ""}\n` +
    `  Runner: ${job.ref ?? "no runner reference"}\n` +
    `  ${job.progress ?? "no progress reported"} · observed ${job.observedAt}${job.eta ? ` · ETA ${job.eta}` : ""}\n`
  );
}

async function execute(io: Io, config: ArmadaConfig, root: string, command: string, job: Job, signal?: AbortSignal) {
  if (!io.exec) throw new UsageError("job commands need shell execution on this machine");
  return io.exec("sh", ["-c", command], {
    cwd: root,
    timeoutMs: 120_000,
    maxOutputBytes: 64 * 1024,
    processGroup: true,
    ...(signal ? { signal } : {}),
    env: {
      ...io.env,
      ARMADA_JOB_ID: String(job.id),
      ARMADA_JOB_REF: job.ref ?? "",
      ARMADA_TICKET: job.ticket,
      ARMADA_PROJECT: config.project.slug,
    },
  });
}

/** Failures after dispatch must leave a recoverable record and never dispatch again. */
async function observe(fleet: Fleet, job: Job, input: Parameters<Fleet["observeJob"]>[0]): Promise<Job> {
  try {
    const result = await fleet.observeJob(input);
    if (!result) throw new Error("job record is unavailable");
    return result;
  } catch {
    throw new Error(
      `Armada could not record the outcome of job ${job.id}. Do not retry the runner command. Runner reference: ${input.ref ?? job.ref ?? "none"}. After checking the runner, save its known outcome with armada job recover ${job.id} --state ${input.state}${input.ref ? ` --ref '${input.ref.replaceAll("'", "'\"'\"'")}'` : ""}`,
    );
  }
}

export async function jobCommand(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: JobArgs,
  configPath: string,
): Promise<number> {
  const [sub, value, ...extra] = args.rest;
  if (!sub || !["start", "status", "stop", "list", "recover", "beat"].includes(sub))
    throw new UsageError("job needs a command: start, status, stop, list, recover or beat");
  if (extra.length || (sub === "list" && value)) throw new UsageError(`unexpected job ${sub} arguments`);
  if (args.options.ticket && sub !== "start" && sub !== "list")
    throw new UsageError(`--ticket does not apply to job ${sub}`);
  if (args.options.ref !== undefined && sub !== "recover") throw new UsageError("--ref applies only to job recover");
  if (args.options.state !== undefined && sub !== "recover" && sub !== "beat")
    throw new UsageError("--state applies only to job recover or beat");
  if (args.options.progress !== undefined && sub !== "beat")
    throw new UsageError("--progress applies only to job beat");
  if (sub === "beat" && args.options.progress !== undefined && args.options.progress.length > JOB_PROGRESS_MAX)
    throw new UsageError(`progress must be at most ${JOB_PROGRESS_MAX} characters`);
  const signIn = credentials.armadaSignIn;
  if (signIn?.kind === "worker" && signIn.project !== config.project.slug)
    throw new UsageError("this worker session belongs to another project");
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet) throw new UsageError("jobs need a sign-in to Armada", "armada login");
  const now = () => io.now?.() ?? new Date();
  const root = dirname(configPath);
  const print = (jobs: Job[]) =>
    io.stdout(
      args.json
        ? `${JSON.stringify(jobs, null, 2)}\n`
        : jobs.length
          ? jobs.map((j) => renderJob(j, config, now())).join("")
          : "No jobs.\n",
    );

  if (sub === "start") {
    if (!value) throw new UsageError("job start needs a configured name");
    const def = definition(config, value);
    if (!io.exec) throw new UsageError("job commands need shell execution on this machine");
    const ticket = currentTicket(io, config, args.options.ticket, credentials.workerTickets);
    const job = await fleet.startJob({ name: value, ticket });
    io.stderr(`Starting job ${job.id} for ${job.ticket}.\n`);
    let result: ExecResult;
    try {
      result = await execute(io, config, root, def.start, job);
    } catch {
      const lost = await observe(fleet, job, {
        id: job.id,
        ticket,
        state: "lost",
        progress: "start outcome unknown; check the runner before starting another job",
      });
      print([lost]);
      return 1;
    }
    if (result.code !== 0 || result.timedOut || result.outputExceeded) {
      const unknown = result.timedOut || result.outputExceeded;
      const failed = await observe(fleet, job, {
        id: job.id,
        ticket,
        state: unknown ? "lost" : "failed",
        progress: unknown
          ? "start outcome unknown; check the runner before starting another job"
          : `start command exited ${result.code}; not started`,
      });
      print([failed]);
      return 1;
    }
    const line = lastJobLine(result.stdout);
    const ref = line.length <= JOB_REF_MAX ? line || null : null;
    const running = await observe(fleet, job, { id: job.id, ticket, state: "running", ref });
    if (!ref) io.stderr(`! Job ${job.id} has no runner reference; status and stop cannot contact it.\n`);
    print([running]);
    return 0;
  }

  let id: number | undefined;
  if (value) {
    id = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(id) || id < 1) throw new UsageError("job id must be a positive integer");
  }
  if ((sub === "stop" || sub === "recover" || sub === "beat") && id === undefined)
    throw new UsageError(`job ${sub} needs an id`);
  const jobs = await fleet.listJobs({
    ...(id === undefined ? {} : { id }),
    ...(sub === "status" && id === undefined ? { open: true } : {}),
    ...(args.options.ticket ? { ticket: args.options.ticket.toUpperCase() } : {}),
  });
  if (id !== undefined && !jobs.length) throw new UsageError(`job ${id} is not on this ticket and project`);
  if (sub === "list") {
    print(jobs);
    return 0;
  }
  if (sub === "beat") {
    const job = jobs[0] as Job;
    const state = args.options.state ?? "running";
    if (state === "starting" || !JOB_STATES.includes(state as JobState))
      throw new UsageError("job beat state must be running|succeeded|failed|stopped|lost");
    const saved = await fleet.observeJob({
      id: job.id,
      ticket: job.ticket,
      state: state as Exclude<JobState, "starting">,
      ...(args.options.progress === undefined ? {} : { progress: args.options.progress }),
    });
    if (!saved) throw new UsageError(`job ${job.id} is not on this ticket and project`);
    if (saved.state !== state)
      throw new UsageError(`job ${job.id} is already ${saved.state}; its outcome cannot change`);
    print([saved]);
    return 0;
  }
  if (sub === "recover") {
    const job = jobs[0] as Job;
    const ref = args.options.ref;
    const state = args.options.state ?? (ref ? "running" : undefined);
    if (!state || state === "starting" || !JOB_STATES.includes(state as JobState))
      throw new UsageError("job recover needs --ref or --state running|succeeded|failed|stopped|lost");
    if (ref !== undefined && (!ref.trim() || ref.length > JOB_REF_MAX))
      throw new UsageError(`runner reference must be nonblank and at most ${JOB_REF_MAX} characters`);
    if (ref !== undefined && job.ref !== null && ref !== job.ref)
      throw new UsageError("runner reference is already recorded and cannot change");
    if (!jobIsOpen(job)) {
      if (state !== job.state) throw new UsageError(`job ${job.id} is already ${job.state}; its outcome cannot change`);
      print([job]);
      return 0;
    }
    if (state === "running" && !(ref ?? job.ref)) throw new UsageError(`job ${job.id}: no runner reference; use --ref`);
    const saved = await observe(fleet, job, {
      id: job.id,
      ticket: job.ticket,
      state: state as Exclude<JobState, "starting">,
      ...(ref === undefined ? {} : { ref }),
      progress: job.progress,
      eta: state === "running" ? job.eta : null,
    });
    if (saved.state !== state || (ref !== undefined && saved.ref !== ref))
      throw new UsageError(`job ${job.id} changed while recovering; read armada job list`);
    print([saved]);
    return 0;
  }
  let code = 0;
  const observed: Job[] = [];
  for (const job of jobs) {
    if (!jobIsOpen(job)) {
      observed.push(job);
      continue;
    }
    try {
      if (!job.ref) throw new UsageError(`job ${job.id}: no runner reference`);
      const def = definition(config, job.name);
      if (sub === "status" && !def.status) {
        observed.push(job);
        continue;
      }
      if (sub === "status" && job.revision === undefined) {
        io.stderr(`armada: warning: job ${job.id} status requires an updated dashboard; reading stored progress.\n`);
        observed.push(job);
        continue;
      }
      const result = await execute(io, config, root, sub === "stop" ? def.stop : (def.status as string), job);
      if (result.code !== 0 || result.timedOut || result.outputExceeded)
        throw new Error(
          `job ${job.id}: ${sub} command ${result.timedOut ? "timed out" : result.outputExceeded ? "exceeded its output bound" : `exited ${result.code}`}; outcome not recorded, check the runner before retrying`,
        );
      const update =
        sub === "stop"
          ? { state: "stopped" as const, progress: "stopped by request", eta: null }
          : parseJobStatus(result.stdout, job.startedAt, now());
      observed.push(
        await observe(fleet, job, {
          id: job.id,
          ticket: job.ticket,
          ...update,
          ...(sub === "status" ? { expectedRevision: job.revision } : {}),
        }),
      );
    } catch (err) {
      code = 1;
      observed.push(job);
      io.stderr(`! ${err instanceof Error ? err.message : `job ${job.id} command failed`}.\n`);
    }
  }
  print(observed);
  return code;
}

/** Coordinator-only polling; failed probes retain the last news and become silent at read time. */
export function refreshingJobsFleet(
  io: Io,
  fleet: Fleet,
  config: ArmadaConfig,
  root: string,
  signal: AbortSignal,
): Fleet {
  const paths = machinePaths(io.env);
  const namespace = `${config.project.slug}.job-observe`;
  const attempted: Record<string, string> = {};
  return {
    ...fleet,
    inbox: async (query) => {
      if (!io.exec) return fleet.inbox(query);
      const openJobs = await fleet.listJobs({ open: true });
      let jobs = openJobs;
      if (query.scope === "mine") {
        const [handles, launches] = await Promise.all([fleet.runtimeHandles(), fleet.pendingLaunches()]);
        const owners = ticketOwners(handles, launches);
        jobs = jobs.filter((job) => owners.get(job.ticket) === (query.coordinatorName ?? "default"));
      }
      let locked = false;
      try {
        if (paths) {
          const lock = await takeWatchLock(paths, namespace, io.pid ?? process.pid, io.processAlive ?? processAlive);
          if (!lock.taken) return await fleet.inbox(query);
          locked = true;
        }
        const saved = paths ? await readWatchState(paths, namespace) : null;
        const attempts = { ...attempted, ...saved?.jobObserved };
        const now = io.now?.() ?? new Date();
        const eligible = jobs.filter((job) => {
          const def = config.jobs?.[job.name];
          if (!job.ref || !def?.status || job.revision === undefined) return false;
          const interval = def.silenceMinutes * 30_000;
          const last = Math.max(Date.parse(job.observedAt), Date.parse(attempts[job.id] ?? "") || 0);
          if (now.getTime() - last < interval) return false;
          return true;
        });
        // Prune old jobs; queued probes reserve again immediately before their own shell I/O.
        const openIds = new Set(openJobs.map((job) => String(job.id)));
        for (const id of Object.keys(attempts))
          if (!openIds.has(id)) {
            delete attempts[id];
            delete attempted[id];
          }
        if (paths) await updateWatchState(paths, namespace, { jobObserved: { ...attempts } });
        let saving = Promise.resolve();
        const recordAttempt = (job: Job) => {
          const next = saving.then(async () => {
            signal.throwIfAborted();
            attempts[job.id] = (io.now?.() ?? new Date()).toISOString();
            attempted[job.id] = attempts[job.id] as string;
            if (paths) await updateWatchState(paths, namespace, { jobObserved: { ...attempts } });
          });
          saving = next.catch(() => {});
          return next;
        };
        let index = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, eligible.length) }, async () => {
            for (;;) {
              const job = eligible[index++];
              if (!job || signal.aborted) return;
              try {
                const command = config.jobs[job.name]?.status;
                if (!command) continue;
                await recordAttempt(job);
                signal.throwIfAborted();
                const result = await execute(io, config, root, command, job, signal);
                if (signal.aborted) return;
                if (result.code !== 0 || result.timedOut || result.outputExceeded)
                  throw new Error("status command failed");
                const update = parseJobStatus(result.stdout, job.startedAt, io.now?.() ?? new Date());
                await fleet.observeJob({
                  id: job.id,
                  ticket: job.ticket,
                  expectedRevision: job.revision,
                  ...update,
                });
              } catch {
                // Neither command output nor provider errors are safe to print.
                io.stderr(`armada: warning: job ${job.id} status probe failed; last observation retained.\n`);
              }
            }
          }),
        );
      } catch {
        // A failed throttle store must never flood the runner; continue reading its stored alarms.
        io.stderr("armada: warning: job status polling unavailable; reading stored observations.\n");
      } finally {
        if (paths && locked) await releaseWatchLock(paths, namespace, io.pid ?? process.pid).catch(() => {});
      }
      return fleet.inbox(query);
    },
  };
}
