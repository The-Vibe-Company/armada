// `armada watch` and `armada hook stop`: the coordinator keeps listening to its
// fleet. The watch runs in the background until something needs the
// coordinator; the stop hook keeps a Claude Code coordinator from ending its
// turn while workers are in flight and no watch runs. Both share the project's
// watch state on this machine (`machine.ts`), which `inbox` and `merge` keep
// current too. Every coordinator command ends on the re-arm line.
import { dirname, join } from "node:path";
import {
  ArmadaApiError,
  type ArmadaConfig,
  type CoordinatorHabit,
  type Credentials,
  checkInbox,
  coordinatorHabits,
  entryKey,
  eventCursor,
  FOLLOW_KINDS,
  type FollowOptions,
  findSessionStartHook,
  findStopHook,
  followFleet,
  type HookRun,
  type InboxEntry,
  type InboxReport,
  loadStatus,
  type MachinePaths,
  machinePaths,
  parseConfig,
  parseEventCursor,
  processAlive,
  type Rearm,
  Refusal,
  readHookRuns,
  readWatchLockInfo,
  readWatchResult,
  readWatchResultSince,
  readWatchState,
  readWatchStates,
  rearm,
  recordHookRun,
  releaseWatchLock,
  reserveNotice,
  runningWatch,
  type StopHookState,
  sameWatchLock,
  setWatchStopRequest,
  shellWord,
  stopHookDecision,
  stopHookState,
  takeWatchLock,
  updateWatchState,
  type WatchIdentity,
  type WatchLock,
  type WatchResult,
  type WatchState,
  watchInbox,
  writeWatchResult,
} from "@armada/core";
import { version } from "../package.json" with { type: "json" };
import { loadCredentials } from "./auth.ts";
import { coordinatorName, validCoordinator } from "./coordinator.ts";
import { deliveringFleet } from "./deliveries.ts";
import { renderEntries } from "./inbox.ts";
import { httpOptions, type Io, UsageError, type WatchSignal } from "./io.ts";
import { refreshingJobsFleet } from "./job.ts";
import { requireSignIn } from "./login.ts";
import { detectCoordinator, recordPresence } from "./presence.ts";
import { noticeRelease, pendingRelease } from "./release.ts";
import { compactLine, renderStatus } from "./render.ts";
import { fsRepoView } from "./repo.ts";
import { observingFleet } from "./runtime.ts";
import { liveFleet, statusLive, type WorkerArgs } from "./worker.ts";

/** The coordinator's own session, never counted as a worker: ARMADA_COORDINATOR_HANDLE, else Conductor's. */
export function coordinatorHandle(io: Io): string | null {
  const workspace = io.env.CONDUCTOR_WORKSPACE_ID?.trim();
  const session = io.env.CONDUCTOR_SESSION_ID?.trim();
  return io.env.ARMADA_COORDINATOR_HANDLE?.trim() || (workspace && session ? `${workspace}/${session}` : null);
}

const alive = (io: Io) => io.processAlive ?? processAlive;

/**
 * Keeps what the coordinator was just shown in the project's watch state, best
 * effort: a machine without a writable config directory only loses the cache.
 */
export async function remember(io: Io, project: string, patch: Partial<WatchState>): Promise<void> {
  const paths = machinePaths(io.env);
  if (!paths) return;
  try {
    const name = await coordinatorName(io, project);
    const session = io.env.CLAUDECODE && !io.env.ARMADA_TICKET?.trim() ? io.env.CLAUDE_CODE_SESSION_ID?.trim() : null;

    await updateWatchState(
      paths,
      project,
      patch,
      name,
      session ? { id: session, at: now(io).toISOString(), root: io.coordinatorRoot ?? io.cwd } : undefined,
    );
  } catch (err) {
    io.stderr(
      `armada: warning: could not keep the watch state (${err instanceof Error ? err.message : String(err)})\n`,
    );
  }
}

/** The project's watch state and live watch on this machine; nothing when there is no machine store. */
export async function watchOf(io: Io, project: string): Promise<{ state: WatchState | null; running: number | null }> {
  const paths = machinePaths(io.env);
  if (!paths) return { state: null, running: null };
  const name = await coordinatorName(io, project);
  const [state, running] = await Promise.all([
    readWatchState(paths, project, name),
    runningWatch(paths, project, alive(io), name).catch(() => null),
  ]);
  return { state, running };
}

/** The re-arm line for what a command just read: the tickets in flight, the open items. */
export async function rearmFor(
  io: Io,
  project: string,
  o: {
    inFlight: string[] | null;
    open: number | null;
    openJobs?: number[];
    act?: boolean;
    waiting?: number;
    pendingDeliveries?: string[];
    slots?: { taken: number; max: number | null };
  },
): Promise<Rearm> {
  const { state, running } = await watchOf(io, project);
  const paths = machinePaths(io.env);
  const mode =
    paths && running ? (await readWatchLockInfo(paths, project, await coordinatorName(io, project)))?.mode : undefined;
  const next = rearm({
    ...o,
    waiting: o.waiting ?? state?.waiting?.length,
    slots: o.slots ?? state?.slots,
    openJobs: o.openJobs ?? state?.openJobs,
    pendingDeliveries: o.pendingDeliveries ?? state?.pendingDeliveries,
    running,
    mode,
  });
  const banner = await stopHookBanner(io);
  if (banner) next.line += `\n${banner}`;
  return next;
}

/** Settings are read through Io, never written; receipts live only in the machine adapter. */
export async function hookStatus(
  io: Io,
  root = io.coordinatorRoot ?? io.cwd,
): Promise<{ status: StopHookState; installedIn: string | null; sessionStartInstalledIn: string | null }> {
  const files = [
    ...(io.env.HOME ? [join(io.env.HOME, ".claude/settings.json")] : []),
    join(root, ".claude/settings.json"),
    join(root, ".claude/settings.local.json"),
  ];
  const [installedIn, sessionStartInstalledIn] = await Promise.all([
    findStopHook(io.readFile, files),
    findSessionStartHook(io.readFile, files),
  ]);
  const paths = machinePaths(io.env);
  const sessionId = io.env.CLAUDE_CODE_SESSION_ID?.trim() || null;
  const hookRun =
    paths && sessionId
      ? ((await readHookRuns(paths).catch(() => ({}) as Record<string, HookRun>))[sessionId] ?? null)
      : null;
  return {
    installedIn,
    sessionStartInstalledIn,
    status: stopHookState({ env: io.env, sessionId, hookRun, installedIn }),
  };
}

export function hookStatusLine(status: StopHookState): string {
  if (status.state === "on") {
    const at = new Date(status.why.slice("last ran ".length));
    const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    return `Stop hook on for this session (last ran ${time})`;
  }
  if (status.state === "installed") return `Stop hook installed in ${status.why}; ${status.fix}`;
  return `Stop hook NOT on: ${status.why} — ${status.fix}`;
}

export async function stopHookBanner(io: Io): Promise<string | null> {
  return io.env.CLAUDECODE ? hookStatusLine((await hookStatus(io)).status) : null;
}

const now = (io: Io) => (io.now ?? (() => new Date()))();

/** What a listing showed; remember preserves each entry's original reminder clock. */
export const shown = (
  io: Io,
  items: InboxEntry[],
  inFlight: string[] | null,
  openJobs: number[] = [],
  scope: "mine" | "all" = "all",
  shownAt?: WatchState["shownAt"],
): Partial<WatchState> => ({
  seen: items.map(entryKey),
  shownAt: Object.fromEntries(
    items.map((entry) => {
      const key = entryKey(entry);
      return [key, shownAt?.[key] ?? { first: now(io).toISOString(), level: 0 }];
    }),
  ),
  seenScope: scope,
  openJobs,
  ...(inFlight ? { inFlight, readAt: now(io).toISOString() } : {}),
  stopped: null,
});

export async function watch(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  a: WorkerArgs,
  configPath: string,
  startedAt = now(io),
) {
  if (a.rest.length) throw new UsageError(`unexpected argument ${a.rest[0]}`);
  const project = config.project.slug;
  try {
    if (a.options.mine && a.options.all) throw new UsageError("choose --mine or --all");
    if (!a.options.follow && ["since", "tickets", "kinds"].some((k) => a.options[k]))
      throw new UsageError("--since, --tickets and --kinds need --follow");
    if (a.options.since) {
      try {
        parseEventCursor(a.options.since);
      } catch (err) {
        throw new UsageError((err as Error).message);
      }
    }
    const kinds = a.options.kinds?.split(",");
    if (kinds?.some((k) => k !== "all" && !FOLLOW_KINDS.includes(k as never)))
      throw new UsageError(`unknown follow kind; choose ${FOLLOW_KINDS.join(", ")} or all`);
    const tickets = a.options.tickets?.split(",").map((t) => t.trim().toUpperCase());
    if (tickets?.some((t) => !/^[A-Z][A-Z0-9]{0,15}-\d{1,9}$/.test(t)))
      throw new UsageError("--tickets needs comma-separated ticket identifiers");
    const minutes = a.options.for === undefined ? undefined : Number(a.options.for);
    if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0 || minutes > 525600))
      throw new UsageError("--for needs positive minutes (at most 525600)");
    return await watchUntil(io, config, credentials, a.json, configPath, {
      follow: !!a.options.follow,
      scope: a.options.mine ? "mine" : a.options.all ? "all" : undefined,
      cursor: a.options.since,
      kinds: kinds?.includes("all") ? FOLLOW_KINDS : kinds,
      tickets,
      minutes,
      startedAt,
    });
  } catch (err) {
    // A watch that cannot run (signed out, refused, Armada unknown): the stop hook stops asking for one.
    await remember(io, project, { stopped: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Stops only a holder whose process identity still matches this project's lock. No network or credentials. */
export async function stopWatch(io: Io, project: string, json: boolean, override?: string): Promise<number> {
  const name = override === undefined ? await coordinatorName(io, project) : validCoordinator(override);
  const paths = machinePaths(io.env);
  const lock = paths ? await readWatchLockInfo(paths, project, name) : null;
  const print = (pid: number | null) => {
    const line =
      pid === null
        ? `no watch running for ${project}${name === "default" ? "" : ` (${name})`}`
        : `Stopped armada watch ${lock?.mode === "follow" ? "following" : "for"} ${project}${name === "default" ? "" : ` (${name})`} (pid ${pid}).`;
    io.stdout(json ? `${JSON.stringify({ project, coordinator: name, stopped: pid, line }, null, 2)}\n` : `${line}\n`);
  };
  if (!paths || !lock) {
    print(null);
    return 0;
  }
  const recordStopped = async () => {
    const identity = lock.identity;
    if (identity && lock.mode !== "follow") {
      await writeWatchResult(
        paths,
        project,
        lock,
        {
          pid: lock.pid,
          started: identity.started,
          endedAt: now(io).toISOString(),
          outcome: "stopped",
          stopRequested: true,
          exit: 0,
          stdout: `armada watch for ${project} stopped by armada watch --stop\n`,
          stderr: "",
        },
        name,
      ).catch(() => {});
    }
  };
  if (!alive(io)(lock.pid)) {
    await recordStopped();
    await releaseWatchLock(paths, project, lock.pid, lock.identity ?? undefined, name);
    print(null);
    return 0;
  }
  const identity = lock.identity;
  if (!io.signalProcess || !(await verifiedWatch(io, paths, project, name, lock))) {
    throw new Refusal(
      `cannot verify armada watch for ${project} (pid ${lock.pid}); left the process and lock untouched`,
      "armada watch --help",
    );
  }
  if (!(await setWatchStopRequest(paths, project, lock, true, name))) {
    print(null);
    return 0;
  }
  try {
    await io.signalProcess(lock.pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      await setWatchStopRequest(paths, project, lock, false, name);
      throw err;
    }
    await recordStopped();
    await releaseWatchLock(paths, project, lock.pid, identity ?? undefined, name);
    print(null);
    return 0;
  }
  await recordStopped();
  await releaseWatchLock(paths, project, lock.pid, identity ?? undefined, name);
  print(lock.pid);
  return 0;
}

async function verifiedWatch(
  io: Io,
  paths: MachinePaths,
  project: string,
  name: string,
  lock: WatchLock,
): Promise<boolean> {
  const identity = lock.identity;
  let configProject: string | null = null;
  if (identity) {
    try {
      const text = await io.readFile(identity.configPath);
      if (text !== null) configProject = parseConfig(text, identity.configPath).project.slug;
    } catch {}
  }
  const process = identity ? await io.inspectProcess?.(lock.pid) : null;
  // The command must be the CLI's watch, not a wrapper, heartbeat or stop command.
  const isWatch =
    identity &&
    /(?:^|\s)(?:\S*\/)?(?:armada(?:\.js)?|packages\/cli\/src\/(?:main|bin)\.ts)\s+(?:(?:--json|--all)\s+|--(?:config|project)(?:=\S+|\s+\S+)\s+)*watch(?:\s|$)/.test(
      identity.command,
    ) &&
    !/(?:^|\s)--stop(?:\s|$)/.test(identity.command);
  if (
    !identity ||
    identity.project !== project ||
    (identity.coordinatorName ?? "default") !== name ||
    configProject !== project ||
    !isWatch ||
    !process ||
    process.started !== identity.started ||
    process.command !== identity.command ||
    process.cwd !== identity.cwd ||
    !sameWatchLock(await readWatchLockInfo(paths, project, name), lock)
  ) {
    return false;
  }
  return true;
}

/** Long watches re-arm bounded Node timers; clock and timer are injected for deterministic checks. */
export function watchDeadline(
  until: Date,
  clock: () => Date,
  expire: () => void,
  schedule: (run: () => void, ms: number) => () => void = (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
): () => void {
  let cancel = () => {};
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const left = until.getTime() - clock().getTime();
    if (left <= 0) {
      expire();
      return;
    }
    cancel = schedule(arm, Math.min(left, 2 ** 31 - 1));
  };
  arm();
  return () => {
    stopped = true;
    cancel();
  };
}

async function watchUntil(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  json: boolean,
  configPath: string,
  options: {
    scope?: "mine" | "all";
    follow: boolean;
    cursor?: string;
    kinds?: readonly string[];
    tickets?: string[];
    minutes?: number;
    startedAt: Date;
  },
): Promise<number> {
  requireSignIn(credentials);
  const project = config.project.slug;
  const name = await coordinatorName(io, project, dirname(configPath));
  const scope = options.scope ?? (name === "default" ? "all" : "mine");
  // The running watch keeps its role even if another terminal changes this checkout preference.
  io = { ...io, coordinatorRoot: dirname(configPath), env: { ...io.env, ARMADA_COORDINATOR: name } };
  const paths: MachinePaths | null = machinePaths(io.env);
  const pid = io.pid ?? process.pid;
  const waiterStarted = options.startedAt;
  const output = { stdout: "", stderr: "" };
  const terminal = io;
  io = {
    ...io,
    stdout: (text) => {
      if (!options.follow) output.stdout += text;
      terminal.stdout(text);
    },
    stderr: (text) => {
      if (!options.follow) output.stderr += text;
      terminal.stderr(text);
    },
  };
  let outcome: WatchResult["outcome"] = "error";
  let exit = 0;
  let boundLine: string | undefined;
  let boundPrinted = false;
  const controller = new AbortController();
  let stoppedBy: WatchSignal | null = null;
  let unsubscribe: (() => void) | undefined;
  let identity: WatchIdentity | undefined;
  let taken = false;
  let replayed = false;
  let stopRequested = false;
  let timedOut = false;
  let cancelDeadline: (() => void) | undefined;
  let noticeIo: Io | undefined;
  let until: Date | undefined;
  const automatic = !!io.env.CLAUDECODE && options.minutes === undefined;
  const setBound = (limit?: number) => {
    if (automatic) {
      options.minutes = limit ? Math.max(5, Math.floor(0.9 * limit)) : 100;
      boundLine = limit
        ? `Bounded to ${options.minutes} min under Claude Code (learned background limit: ${limit} min); --for <minutes> changes it.`
        : "Bounded to 100 min under Claude Code (background commands end after 2 h); --for <minutes> changes it.";
    }
    until = options.minutes === undefined ? undefined : new Date(waiterStarted.getTime() + options.minutes * 60000);
  };
  const sleep =
    io.sleep ??
    ((ms: number) =>
      new Promise<void>((done) => {
        const finish = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", finish);
          done();
        };
        const timer = setTimeout(finish, ms);
        controller.signal.addEventListener("abort", finish, { once: true });
      }));
  const pause = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      controller.signal.throwIfAborted();
      const abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => sleep(ms))
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener("abort", abort));
    });
  const armDeadline = () => {
    cancelDeadline?.();
    if (until && !io.sleep)
      cancelDeadline = watchDeadline(
        until,
        () => now(io),
        () => {
          timedOut = true;
          controller.abort(new Error("watch duration ended"));
        },
      );
  };
  let lastInFlight: string[] | null = null;
  let lastJobs: number[] = [];
  let lastDeliveries: string[] = [];
  let lastWaiting = 0;
  let lastSlots: WatchState["slots"];
  const resume = () => {
    const flags = [
      ...(name === "default" ? [] : [`ARMADA_COORDINATOR=${name}`]),
      "armada watch",
      ...(options.follow ? ["--follow"] : []),
      ...(options.scope ? [`--${scope}`] : []),
      "--project",
      project,
      ...(options.cursor ? ["--since", options.cursor] : []),
      ...(options.tickets ? ["--tickets", options.tickets.join(",")] : []),
      ...(options.kinds ? ["--kinds", options.kinds.join(",")] : []),
      ...(json ? ["--json"] : []),
    ];
    outcome = "timeout";
    if (options.follow) io.stderr(`resume: ${flags.join(" ")}\n`);
    else {
      if (boundLine && !json) {
        io.stdout(`${boundLine}\n`);
        boundPrinted = true;
      }
      const line = `No new item in ${options.minutes} min; start it again: ${flags.join(" ")}`;
      const next = rearm({
        inFlight: lastInFlight,
        openJobs: lastJobs,
        waiting: lastWaiting,
        pendingDeliveries: lastDeliveries,
        slots: lastSlots,
        open: null,
        running: null,
      });
      io.stdout(
        json
          ? `${JSON.stringify({ outcome: "timeout", line, watch: next, ...(boundLine ? { bound: boundLine } : {}) }, null, 2)}\n`
          : `${line}\n${next.line}\n`,
      );
    }
  };
  const replayResult = (result: WatchResult): number => {
    replayed = true;
    if (result.stopRequested) {
      const line = `armada watch for ${project} stopped by armada watch --stop`;
      io.stdout(json ? `${JSON.stringify({ project, outcome: "stopped", exit: 0, line }, null, 2)}\n` : `${line}\n`);
      return 0;
    }
    io.stdout(json && !result.json ? `${JSON.stringify(result, null, 2)}\n` : result.stdout);
    io.stderr(result.stderr);
    return result.exit;
  };
  const freshResult = async () =>
    paths && !options.follow ? readWatchResultSince(paths, project, waiterStarted, name) : null;
  try {
    unsubscribe = io.onSignal?.((signal) => {
      if (stoppedBy) return;
      stoppedBy = signal;
      controller.abort(new Error("watch stopped"));
    });
    controller.signal.throwIfAborted();
    const inspected = await io.inspectProcess?.(pid);
    identity = inspected
      ? {
          ...inspected,
          project,
          configPath,
          watchStartedAt: waiterStarted.toISOString(),
          ...(name === "default" ? {} : { coordinatorName: name }),
        }
      : undefined;
    controller.signal.throwIfAborted();
    await remember(io, project, {});
    const startBanner = await stopHookBanner(io);
    const initialState = paths ? await readWatchState(paths, project, name) : null;
    lastInFlight = initialState?.inFlight ?? null;
    lastJobs = initialState?.openJobs ?? [];
    lastWaiting = initialState?.waiting?.length ?? 0;
    lastDeliveries = initialState?.pendingDeliveries ?? [];
    lastSlots = initialState?.slots;
    setBound(initialState?.harnessLimitMinutes);
    if (paths && automatic) {
      const stale = await readWatchLockInfo(paths, project, name);
      if (stale?.identity && !alive(io)(stale.pid) && !(await readWatchResult(paths, project, stale, name))) {
        const lifetime =
          (now(io).getTime() - Date.parse(stale.identity.watchStartedAt ?? stale.identity.started)) / 60000;
        if (lifetime >= 5 && lifetime < (options.minutes ?? 100)) {
          const limit = Math.round(lifetime);
          await remember(io, project, { harnessLimitMinutes: limit });
          setBound(limit);
          io.stderr(
            `The previous watch was ended from outside after ${limit} min; this one ends itself after ${options.minutes} min.\n`,
          );
        }
      }
    }
    if (boundLine) io.stderr(`${boundLine}\n`);
    if (startBanner) io.stderr(`${startBanner}\n`);
    armDeadline();
    if (paths) {
      while (!taken) {
        controller.signal.throwIfAborted();
        if (until && now(io) >= until) {
          resume();
          return 0;
        }
        const completed = await freshResult();
        if (completed) return replayResult(completed);
        const captured = await readWatchLockInfo(paths, project, name);
        let lock: Awaited<ReturnType<typeof takeWatchLock>>;
        try {
          lock = await takeWatchLock(
            paths,
            project,
            pid,
            alive(io),
            identity,
            options.follow ? "follow" : undefined,
            name,
          );
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ELOCKED" || code === "ECOMPROMISED") {
            await pause(Math.min(2000, until ? Math.max(0, until.getTime() - now(io).getTime()) : 2000));
            continue;
          }
          if (!["EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR"].includes(code ?? "")) throw err;
          io.stderr(
            `armada: warning: could not keep the watch lock (${err instanceof Error ? err.message : String(err)}); watching without it\n`,
          );
          break;
        }
        taken = lock.taken;
        const finished = await freshResult();
        if (finished) return replayResult(finished);
        if (lock.taken) break;
        const currentHolder = await readWatchLockInfo(paths, project, name);
        const holder = currentHolder?.pid === lock.pid ? currentHolder : captured?.pid === lock.pid ? captured : null;
        if (!holder) continue;
        const replay = async (): Promise<number | null> => {
          const result = await readWatchResult(paths, project, holder, name);
          if (!result || Date.parse(result.endedAt) <= waiterStarted.getTime()) return null;
          return replayResult(result);
        };
        const verified =
          holder.mode !== "follow" && !options.follow ? await verifiedWatch(io, paths, project, name, holder) : false;
        if (
          holder.mode !== "follow" &&
          !options.follow &&
          !verified &&
          (!alive(io)(holder.pid) || !sameWatchLock(await readWatchLockInfo(paths, project, name), holder))
        ) {
          const result = await replay();
          if (result !== null) return result;
          continue;
        }
        if (!verified) {
          const line =
            holder.mode === "follow"
              ? `armada watch is following for ${project} (pid ${holder.pid}).`
              : `armada watch is already running for ${project} (pid ${holder.pid}); cannot verify its identity to share the result.`;
          if (options.follow) io.stderr(`${line}\n`);
          else io.stdout(json ? `${JSON.stringify({ project, running: holder.pid, line }, null, 2)}\n` : `${line}\n`);
          return 0;
        }
        io.stderr(`armada watch already runs (pid ${holder.pid}); waiting for its result here\n`);
        while (true) {
          controller.signal.throwIfAborted();
          if (until && now(io) >= until) {
            resume();
            return 0;
          }
          const current = await readWatchLockInfo(paths, project, name);
          if (!alive(io)(holder.pid) || !sameWatchLock(current, holder)) {
            const result = await replay();
            if (result !== null) return result;
            break;
          }
          await pause(Math.min(2000, until ? Math.max(0, until.getTime() - now(io).getTime()) : 2000));
        }
      }
    }
    const fetch = io.fetch;
    const watchingIo: Io = {
      ...io,
      fetch: fetch
        ? (url, init) =>
            fetch(url, {
              ...init,
              signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
            })
        : undefined,
    };
    noticeIo = watchingIo;
    await recordPresence(watchingIo, config, credentials);
    const { fleet, warning } = liveFleet(watchingIo, config, credentials);
    if (!fleet)
      throw new Refusal(`the inbox is on Armada, which cannot be reached: ${warning ?? "no answer"}`, "armada whoami");
    const before = paths ? await readWatchState(paths, project, name) : null;
    const shownAt = Object.fromEntries(
      (before?.seen ?? []).map((key) => [key, before?.shownAt?.[key] ?? { first: now(io).toISOString(), level: 0 }]),
    );
    await remember(io, project, { root: dirname(configPath), stopped: null, shownAt });
    const watchingFleet = refreshingJobsFleet(
      watchingIo,
      deliveringFleet(watchingIo, observingFleet(watchingIo, fleet, config), config, credentials),
      config,
      dirname(configPath),
      controller.signal,
    );
    const common: FollowOptions = {
      until,
      project,
      signal: controller.signal,
      coordinator: coordinatorHandle(io),
      facts: { ...detectCoordinator(io), name },
      coordinatorName: name,
      scope,
      silentAfterMinutes: config.policy.silentAfterMinutes,
      launchGraceMinutes: config.policy.launchGraceMinutes,
      ciWaitMinutes: config.policy.ciWaitMinutes,
      quietAfterMinutes: config.policy.quietAfterMinutes,
      notStartedMinutes: config.policy.notStartedMinutes,
      seen: before?.seen ?? [],
      shownAt,
      coordinatorMinutes: config.policy.coordinatorMinutes,
      now: io.now ?? (() => new Date()),
      sleep,
      onRead: async (read) => {
        const inFlight =
          name === "default" ? read.inFlight : (read.ownedInFlight ?? (scope === "mine" ? read.inFlight : null));
        const openJobs =
          name === "default" ? read.openJobs : (read.ownedOpenJobs ?? (scope === "mine" ? read.openJobs : []));
        lastInFlight = inFlight;
        lastDeliveries = ((name === "default" ? read.pendingDeliveries : read.ownedPendingDeliveries) ?? []).map(
          (d) => d.ticket,
        );
        lastJobs = openJobs ?? [];
        lastWaiting = (name === "default" ? read.waiting : read.ownedWaiting)?.length ?? 0;
        lastSlots = read.slots;
        if (inFlight)
          await remember(io, project, {
            inFlight,
            openJobs,
            pendingDeliveries: lastDeliveries,
            waiting: name === "default" ? read.waiting : read.ownedWaiting,
            slots: read.slots,
            readAt: now(io).toISOString(),
          });
      },
      onRetry: (message) => io.stderr(`armada: warning: ${message}\n`),
      release: pendingRelease(watchingIo, version),
    };
    if (options.follow) {
      const cursor = options.cursor ?? before?.cursor ?? eventCursor(0, now(io).toISOString());
      const differentCursor = !!options.cursor && options.cursor !== before?.cursor;
      const eventIds = differentCursor ? [] : (before?.eventIds ?? []);
      const seen = differentCursor ? [] : (before?.seen ?? []);
      const freshStart = differentCursor ? false : (before?.freshStart ?? (!options.cursor && !before?.cursor));
      const baselinePending = differentCursor ? true : (before?.baselinePending ?? !eventIds.length);
      await remember(io, project, { cursor, eventIds, seen, freshStart, baselinePending });
      io.stderr(
        `following ${project} as coordinator ${name} (${coordinatorHandle(io) ?? "terminal"}) from ${cursor}; stop: armada watch --stop --name ${name} --project ${project}\n`,
      );
      for await (const line of followFleet(watchingFleet, {
        ...common,
        cursor,
        freshStart,
        baselinePending,
        eventIds,
        seen,
        kinds: options.kinds,
        tickets: options.tickets,
        onPrinted: (patch) => remember(io, project, patch),
        onIdle: () => io.stderr("idle: nothing in flight\n"),
      })) {
        io.stdout(
          json
            ? `${JSON.stringify(line)}\n`
            : `${line.at.slice(11, 16)} UTC ${line.kind} ${line.ticket ?? "-"} [#${line.id ?? "-"}] ${line.queue ? (line.queue.state === "queued" ? `queued in the merge queue (position ${line.queue.position})` : `merging: ${line.queue.detail ?? "starting the drain"}`) : line.body.split(/\r?\n/)[0]}${line.new ? "" : " (open)"} cursor: ${line.cursor}\n`,
        );
        // Advance the explicit resume argument too, so a timed run never replays its start cursor.
        options.cursor = line.cursor;
      }
      timedOut = !!until && now(io) >= until;
      if (timedOut) resume();
      return 0;
    }
    const report = await watchInbox(watchingFleet, common);
    outcome = report.outcome;
    if (report.outcome === "timeout") {
      resume();
      return 0;
    }
    const inFlight =
      name === "default" ? report.inFlight : (report.ownedInFlight ?? (scope === "mine" ? report.inFlight : null));
    const openJobs =
      name === "default" ? report.openJobs : (report.ownedOpenJobs ?? (scope === "mine" ? report.openJobs : undefined));
    const waiting = (name === "default" ? report.waiting : report.ownedWaiting) ?? [];
    const pendingDeliveries = (
      (name === "default" ? report.pendingDeliveries : report.ownedPendingDeliveries) ?? []
    ).map((d) => d.ticket);
    await remember(io, project, {
      ...shown(io, report.items, inFlight, openJobs, scope, report.shownAt),
      waiting,
      pendingDeliveries,
      slots: report.slots,
    });
    controller.signal.throwIfAborted();
    // A release is acted on between rounds: it is not an item that keeps a watch going.
    const open = report.items.filter(
      (e) => e.kind !== "version" && !e.queue && (e.owner == null || e.owner === name),
    ).length;
    const next = rearm({
      inFlight,
      openJobs,
      open,
      running: null,
      act: report.items.some((e) => !e.queue && (e.owner == null || e.owner === name)),
      waiting: waiting.length,
      pendingDeliveries,
      slots: report.slots,
    });
    const banner = await stopHookBanner(io);
    if (banner) next.line += `\n${banner}`;
    if (boundLine && !json) {
      io.stdout(`${boundLine}\n`);
      boundPrinted = true;
    }
    if (json)
      io.stdout(`${JSON.stringify({ ...report, watch: next, ...(boundLine ? { bound: boundLine } : {}) }, null, 2)}\n`);
    else {
      const out =
        report.outcome === "nothing"
          ? [`Nothing to watch on ${project}: no worker in flight and nothing open.`, ...(banner ? [banner] : [])]
          : [...renderEntries(project, report.items), "New items are marked *.", next.line];
      io.stdout(`${out.join("\n")}\n`);
    }
    for (const w of report.warnings) io.stderr(`armada: warning: ${w}\n`);
  } catch (err) {
    if (!stoppedBy && !timedOut) {
      await remember(io, project, { stopped: err instanceof Error ? err.message : String(err) });
      const next =
        err instanceof Refusal || err instanceof ArmadaApiError
          ? err.next
          : err instanceof UsageError
            ? (err.next ?? "armada watch --help")
            : null;
      io.stderr(`armada: ${err instanceof Error ? err.message : String(err)}\n${next ? `Next: ${next}\n` : ""}`);
      exit = err instanceof UsageError || (err instanceof Refusal && err.cause instanceof UsageError) ? 2 : 1;
    }
    if (timedOut) resume();
  } finally {
    if (boundLine && !boundPrinted && !replayed && (options.follow || (taken && !json))) {
      (options.follow ? io.stderr : io.stdout)(`${boundLine}\n`);
    }
    if (options.follow || timedOut || stoppedBy) {
      const banner = await stopHookBanner(io);
      if (banner) io.stderr(`${banner}\n`);
    }
    if (stoppedBy) {
      outcome = "stopped";
      if (paths && taken && identity) {
        const holder = { pid, identity };
        const lock = await readWatchLockInfo(paths, project, name);
        stopRequested =
          (sameWatchLock(lock, holder) && !!lock?.stopRequested) ||
          !!(await readWatchResult(paths, project, holder, name))?.stopRequested;
      }
      exit = stopRequested ? 0 : stoppedBy === "SIGINT" ? 130 : stoppedBy === "SIGTERM" ? 143 : 129;
      const line = stopRequested
        ? `armada watch for ${project} stopped by armada watch --stop`
        : `armada watch for ${project} stopped by ${stoppedBy} (pid ${pid})`;
      (options.follow ? io.stderr : io.stdout)(
        json && !options.follow
          ? `${JSON.stringify({ project, outcome: "stopped", exit, ...(stopRequested ? {} : { signal: stoppedBy }), line }, null, 2)}\n`
          : `${line}\n`,
      );
    }
    if (!options.follow && noticeIo)
      await noticeRelease(noticeIo, version, fsRepoView(dirname(configPath)), { setupOnly: true }).catch(() => {});
    if (paths && taken) {
      if (identity && !options.follow && !replayed)
        await writeWatchResult(
          paths,
          project,
          { pid, identity },
          {
            pid,
            started: identity.started,
            endedAt: now(io).toISOString(),
            outcome,
            exit,
            json,
            ...(stopRequested ? { stopRequested: true } : {}),
            ...output,
          },
          name,
        ).catch(() => {});
      await releaseWatchLock(paths, project, pid, identity, name).catch(() => {});
    }
    unsubscribe?.();
    cancelDeadline?.();
  }
  return exit;
}

/**
 * `armada hook stop`: Claude Code's Stop hook. Reads the hook's input on
 * standard input, then only armada.toml and the watch state: no network, no
 * key, an answer at once. Blocks with Claude Code's `{"decision":"block"}`;
 * allows silently otherwise, and on any error: a hook must never trap a session.
 */
export async function hookStop(
  io: Io,
  rest: string[],
  findConfig: (io: Io) => Promise<{ path: string; text: string }>,
): Promise<number> {
  if (rest[0] !== "stop" || rest.length > 1)
    throw new UsageError(rest[0] ? `unknown hook "${rest.join(" ")}"` : "hook needs a name: armada hook stop");
  const paths = machinePaths(io.env);
  let sessionId: string | null = null;
  let receipt: HookRun = { at: now(io).toISOString(), project: null, why: "not an Armada coordinator session" };
  try {
    const input: unknown = JSON.parse((await io.readStdin?.()) || "{}");
    if (typeof input !== "object" || input === null) return 0;
    const raw = input as {
      cwd?: unknown;
      session_id?: unknown;
      hook_event_name?: unknown;
      transcript_path?: unknown;
      stop_hook_active?: unknown;
    };
    // A worker subagent shares its parent's id, but never fires Stop or writes its receipt.
    if ((raw.hook_event_name && raw.hook_event_name !== "Stop") || io.env.ARMADA_TICKET?.trim()) return 0;
    sessionId =
      typeof raw.session_id === "string" && raw.session_id.trim() && raw.session_id.length <= 256
        ? raw.session_id.trim()
        : null;
    const cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : io.cwd;
    const contexts = await hookCoordinators(io, { ...raw, session_id: sessionId }, findConfig);
    if (!contexts.length) return 0;
    let current: { path: string; config: ArmadaConfig } | null = null;
    try {
      const { path, text } = await findConfig({ ...io, cwd });
      current = { path, config: parseConfig(text, path) };
    } catch {
      /* A registered coordinator may Stop outside any checkout. */
    }
    const eligible = contexts.filter(
      ({ state, root, match }) => state?.root && (match === "session" || state.root === root),
    );
    const selected = eligible.find(({ project }) => project === current?.config.project.slug) ?? eligible[0];
    const habits: CoordinatorHabit[] = [];
    const deployTargets: { name: string; configPath?: string }[] = [];
    const off = io.env.ARMADA_STOP_HOOK?.trim().toLowerCase();
    if (
      paths &&
      sessionId &&
      selected &&
      raw.stop_hook_active === false &&
      io.readFileRange &&
      typeof raw.transcript_path === "string" &&
      raw.transcript_path.length <= 4096 &&
      !["off", "0", "false"].includes(off ?? "")
    ) {
      try {
        // Read once per session, even when it coordinates several projects/names.
        const offset = Math.max(
          0,
          ...eligible.map(({ state }) => {
            const cursor = state?.habitCursors?.[sessionId as string];
            return cursor && cursor.path === raw.transcript_path ? cursor.offset : 0;
          }),
        );
        const chunk = await io.readFileRange(raw.transcript_path, offset, 1024 * 1024);
        if (chunk) {
          const found = coordinatorHabits(chunk.text.split("\n"));
          if (found.some(({ rule }) => rule === "raw-merge")) {
            // Prefer the project of this Stop's checkout. Outside it, name each known config explicitly.
            const currentContext = eligible.find(({ project }) => project === current?.config.project.slug);
            const projects = currentContext ? [currentContext] : eligible;
            const loaded = new Set<string>();
            for (const context of projects) {
              if (loaded.has(context.project)) continue;
              loaded.add(context.project);
              try {
                let config = currentContext && current ? current.config : undefined;
                const path = currentContext && current ? current.path : join(context.root, "armada.toml");
                if (!config) {
                  const text = await io.readFile(path);
                  if (text) config = parseConfig(text, path);
                }
                deployTargets.push(
                  ...(config?.deploy?.targets ?? []).map(({ name }) => ({
                    name,
                    ...(!currentContext ? { configPath: path } : {}),
                  })),
                );
              } catch {
                /* Unreadable deploy config cannot discard the merge-finish or other reminders. */
              }
            }
          }
          for (const finding of found) {
            if (await reserveNotice(paths, `habit:${sessionId}:${finding.rule}`, now(io), Number.POSITIVE_INFINITY))
              habits.push(finding);
          }
          for (const { project, coordinator } of eligible)
            await updateWatchState(
              paths,
              project,
              {
                habitCursors: { [sessionId]: { path: raw.transcript_path, offset: chunk.nextOffset } },
              },
              coordinator,
            );
        }
      } catch {
        /* Transcript failures never suppress the existing watch guard. */
      }
    }
    const decisions = [];
    for (const context of contexts) {
      const watching = paths ? await runningWatch(paths, context.project, alive(io), context.coordinator) : null;
      decisions.push({
        project: context.project,
        decision: stopHookDecision({
          ...context,
          watching,
          env: io.env,
          ...(context === selected ? { habits, deployTargets } : {}),
        }),
      });
    }
    const blocked = decisions.filter(({ decision }) => decision.block);
    receipt = {
      ...receipt,
      project: (blocked[0] ?? decisions[0])?.project ?? null,
      why: blocked.length
        ? "blocked"
        : decisions.map(({ decision }) => (decision.block ? "blocked" : decision.why)).join("; "),
    };
    if (blocked.length)
      io.stdout(
        `${JSON.stringify({ decision: "block", reason: blocked.map(({ decision }) => (decision.block ? decision.reason : "")).join("\n") })}\n`,
      );
  } catch {
    receipt.why = "could not read the coordinator's local hook state or project";
  } finally {
    if (paths && sessionId) await recordHookRun(paths, sessionId, receipt).catch(() => {});
  }
  return 0;
}

/** Shared identity rule for both hooks: registry first, then the previously coordinating checkout. */
async function hookCoordinators(
  io: Io,
  raw: { cwd?: unknown; session_id?: unknown },
  findConfig: (io: Io) => Promise<{ path: string; text: string }>,
) {
  const paths = machinePaths(io.env);
  const session = typeof raw.session_id === "string" ? raw.session_id.trim() : "";
  const registered =
    paths && session
      ? (await readWatchStates(paths)).filter(({ state }) => Object.hasOwn(state.claudeSessions ?? {}, session))
      : [];
  if (registered.length)
    return registered
      .filter(({ state }) => state.root)
      .map((row) => ({ ...row, root: row.state.root as string, match: "session" as const }));
  const cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : io.cwd;
  const selected = { ...io, cwd };
  const { path, text } = await findConfig(selected);
  const root = dirname(path);
  const project = parseConfig(text, path).project.slug;
  const coordinator = await coordinatorName(selected, project, root);
  const state = paths ? await readWatchState(paths, project, coordinator) : null;
  return state?.root === root ? [{ project, coordinator, state, root, match: "checkout" as const }] : [];
}

/** SessionStart stdout is inserted into Claude's context. Never starts a watch or prevents a session start. */
export async function hookSessionStart(
  io: Io,
  findConfig: (io: Io) => Promise<{ path: string; text: string }>,
): Promise<number> {
  let cancel: (() => void) | undefined;
  const controller = new AbortController();
  try {
    const input: unknown = JSON.parse((await io.readStdin?.()) || "{}");
    if (typeof input !== "object" || input === null || io.env.ARMADA_TICKET?.trim()) return 0;
    const raw = input as { source?: unknown; cwd?: unknown; session_id?: unknown; hook_event_name?: unknown };
    if (
      !["compact", "resume"].includes(String(raw.source)) ||
      (raw.hook_event_name && raw.hook_event_name !== "SessionStart")
    )
      return 0;
    const rows = await hookCoordinators(io, raw, findConfig);
    if (!rows.length) return 0;
    const deadline = new Promise<never>((_resolve, reject) => {
      const expire = async () => {
        controller.abort();
        reject(new Error("session brief deadline"));
      };
      if (io.every) cancel = io.every(15_000, expire);
      else {
        const timer = setTimeout(expire, 15_000);
        cancel = () => clearTimeout(timer);
      }
    });
    const fetch = io.fetch ?? globalThis.fetch;
    const exec = io.exec;
    const bounded: Io = {
      ...io,
      stderr: () => {},
      fetch: (url, init) => {
        controller.signal.throwIfAborted();
        return fetch(url, {
          ...init,
          signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
        });
      },
      ...(exec
        ? {
            exec: (command, args, options) =>
              exec(command, args, {
                ...options,
                signal: controller.signal,
                timeoutMs: Math.min(options.timeoutMs ?? 15_000, 15_000),
              }),
          }
        : {}),
    };
    const blocks: string[] = [];
    // Keep room for every selected project's identity, watch, hook banner and next command.
    const selected = rows.slice(0, 5);
    const budget = Math.floor((60 - (rows.length > selected.length ? 1 : 0)) / selected.length);
    for (const row of selected) {
      const at: Io = {
        ...bounded,
        cwd: row.root,
        coordinatorRoot: row.root,
        env: {
          ...bounded.env,
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: typeof raw.session_id === "string" ? raw.session_id : undefined,
          ARMADA_COORDINATOR: row.coordinator,
        },
      };
      let lines: string[];
      try {
        const read = await Promise.race([readSessionBrief(at, row.project, controller.signal), deadline]);
        controller.signal.throwIfAborted();
        // Only keys actually included in the brief are shown; omitted work must still wake the watch.
        const room = Math.max(0, budget - 5);
        const actionable = read.report.items.filter((e) => !e.queue);
        const inboxRoom = Math.min(22, Math.max(2, room - 3));
        const limit = Math.min(20, Math.max(0, inboxRoom - 1 - (actionable.length > inboxRoom - 1 ? 1 : 0)));
        const shownItems = actionable.slice(0, limit);
        const inboxLines = renderEntries(row.project, read.report.items, { compact: true, limit });
        const statusRoom = room - inboxLines.length;
        const truncated = read.statusLines.length > statusRoom;
        lines = [
          ...read.statusLines.slice(0, Math.max(0, statusRoom - (truncated ? 1 : 0))),
          ...(truncated ? ["… more status: armada status --mine"] : []),
          ...inboxLines,
        ];
        controller.signal.throwIfAborted();
        await remember(at, row.project, {
          ...shown(at, shownItems, read.report.inFlight, read.report.openJobs, "mine"),
          waiting: read.report.waiting,
          slots: read.report.slots,
        });
      } catch {
        lines = [
          `Armada could not be read within 15 s or refused this session. Last local read: ${row.state.readAt ?? "unknown"}.`,
          `In flight: ${row.state.inFlight?.join(", ") || "unknown or none"}`,
          `Open jobs: ${row.state.openJobs?.join(", ") || "none known"}`,
        ];
      }
      const paths = machinePaths(at.env);
      const pid = paths ? await runningWatch(paths, row.project, alive(at), row.coordinator).catch(() => null) : null;
      const footer = [
        pid !== null
          ? `armada watch runs (pid ${pid}); its result wakes you`
          : "No watch runs: start it now in the background (Bash run_in_background): armada watch",
        hookStatusLine(
          (
            await hookStatus(at).catch(() => ({
              status: { state: "off" as const, why: "could not read local settings", fix: "armada doctor" },
            }))
          ).status,
        ),
        "Never act from memory: armada status --mine and armada inbox --mine first.",
        pid !== null
          ? "Next: armada inbox --mine"
          : "Next: start armada watch in the background (Bash run_in_background).",
      ];
      blocks.push(
        [
          `Armada: you coordinate ${row.project} as ${row.coordinator} from ${row.root}. Run every armada command there (cd ${shellWord(row.root)}).`,
          ...lines.slice(0, Math.max(0, budget - footer.length - 1)),
          ...footer,
        ]
          .map(compactLine)
          .join("\n"),
      );
    }
    if (rows.length > selected.length)
      blocks.push(`… ${rows.length - selected.length} more coordinated projects: armada status --all`);
    io.stdout(`${blocks.join("\n")}\n`);
  } catch {
  } finally {
    cancel?.();
    controller.abort();
  }
  return 0;
}

async function readSessionBrief(
  io: Io,
  project: string,
  signal: AbortSignal,
): Promise<{ statusLines: string[]; report: InboxReport }> {
  const text = await io.readFile(join(io.cwd, "armada.toml"));
  if (text === null) throw new Error("coordinator config missing");
  const config = parseConfig(text, join(io.cwd, "armada.toml"));
  if (config.project.slug !== project) throw new Error("checkout now coordinates another project");
  const { credentials } = await loadCredentials(io, { project });
  requireSignIn(credentials);
  if (!credentials.linearApiKey) throw new Error("no Linear key");
  const name = await coordinatorName(io, project);
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet) throw new Error("no fleet");
  const [report, status] = await Promise.all([
    checkInbox(fleet, {
      project,
      coordinatorName: name,
      scope: "mine",
      coordinator: coordinatorHandle(io),
      facts: detectCoordinator(io),
      silentAfterMinutes: config.policy.silentAfterMinutes,
      launchGraceMinutes: config.policy.launchGraceMinutes,
      ciWaitMinutes: config.policy.ciWaitMinutes,
      quietAfterMinutes: config.policy.quietAfterMinutes,
      notStartedMinutes: config.policy.notStartedMinutes,
      now: io.now ?? (() => new Date()),
    }),
    loadStatus(config, {
      linearApiKey: credentials.linearApiKey,
      githubToken: credentials.githubToken,
      ...statusLive(io, config, credentials),
      runtimeHandles: () => fleet.runtimeHandles(),
      coordinatorName: name,
      ...httpOptions(io),
    }),
  ]);
  signal.throwIfAborted();
  const statusLines = renderStatus(status, { compact: true }).trimEnd().split("\n");
  return { statusLines, report };
}
