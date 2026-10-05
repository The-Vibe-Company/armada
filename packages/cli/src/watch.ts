// `armada watch` and `armada hook stop`: the coordinator keeps listening to its
// fleet. The watch runs in the background until something needs the
// coordinator; the stop hook keeps a Claude Code coordinator from ending its
// turn while workers are in flight and no watch runs. Both share the project's
// watch state on this machine (`machine.ts`), which `inbox` and `merge` keep
// current too. Every coordinator command ends on the re-arm line.
import { dirname } from "node:path";
import {
  type ArmadaConfig,
  type Credentials,
  entryKey,
  eventCursor,
  FOLLOW_KINDS,
  type FollowOptions,
  followFleet,
  type InboxEntry,
  type MachinePaths,
  machinePaths,
  parseConfig,
  parseEventCursor,
  processAlive,
  type Rearm,
  Refusal,
  readWatchLockInfo,
  readWatchState,
  rearm,
  releaseWatchLock,
  runningWatch,
  sameWatchLock,
  stopHookDecision,
  takeWatchLock,
  updateWatchState,
  type WatchIdentity,
  type WatchState,
  watchInbox,
} from "@armada/core";
import { version } from "../package.json" with { type: "json" };
import { renderEntries } from "./inbox.ts";
import { type Io, UsageError, type WatchSignal } from "./io.ts";
import { requireSignIn } from "./login.ts";
import { detectCoordinator } from "./presence.ts";
import { pendingRelease, rememberRelease } from "./release.ts";
import { observingFleet } from "./runtime.ts";
import { liveFleet, type WorkerArgs } from "./worker.ts";

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
    await updateWatchState(paths, project, patch);
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
  const [state, running] = await Promise.all([
    readWatchState(paths, project),
    runningWatch(paths, project, alive(io)).catch(() => null),
  ]);
  return { state, running };
}

/** The re-arm line for what a command just read: the tickets in flight, the open items. */
export async function rearmFor(
  io: Io,
  project: string,
  o: { inFlight: string[] | null; open: number | null; act?: boolean },
): Promise<Rearm> {
  const { running } = await watchOf(io, project);
  const paths = machinePaths(io.env);
  const mode = paths && running ? (await readWatchLockInfo(paths, project))?.mode : undefined;
  return rearm({ ...o, running, mode });
}

const now = (io: Io) => (io.now ?? (() => new Date()))();

/** What a read showed the coordinator: it does not wake a watch again, and the hook knows who is in flight. */
export const shown = (io: Io, items: InboxEntry[], inFlight: string[] | null): Partial<WatchState> => ({
  seen: items.map(entryKey),
  ...(inFlight ? { inFlight, readAt: now(io).toISOString() } : {}),
  stopped: null,
});

export async function watch(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs, configPath: string) {
  if (a.rest.length) throw new UsageError(`unexpected argument ${a.rest[0]}`);
  const project = config.project.slug;
  try {
    if (a.options.mine)
      throw new UsageError('--mine needs "Show each coordinator only its own work"; until then use --all');
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
      cursor: a.options.since,
      kinds: kinds?.includes("all") ? FOLLOW_KINDS : kinds,
      tickets,
      minutes,
    });
  } catch (err) {
    // A watch that cannot run (signed out, refused, Armada unknown): the stop hook stops asking for one.
    await remember(io, project, { stopped: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Stops only a holder whose process identity still matches this project's lock. No network or credentials. */
export async function stopWatch(io: Io, project: string, json: boolean): Promise<number> {
  const paths = machinePaths(io.env);
  const lock = paths ? await readWatchLockInfo(paths, project) : null;
  const print = (pid: number | null) => {
    const line =
      pid === null
        ? `no watch running for ${project}`
        : lock?.mode === "follow"
          ? `Stopped armada watch following ${project} (pid ${pid}).`
          : `Stopped armada watch for ${project} (pid ${pid}).`;
    io.stdout(json ? `${JSON.stringify({ project, stopped: pid, line }, null, 2)}\n` : `${line}\n`);
  };
  if (!paths || !lock) {
    print(null);
    return 0;
  }
  if (!alive(io)(lock.pid)) {
    await releaseWatchLock(paths, project, lock.pid, lock.identity ?? undefined);
    print(null);
    return 0;
  }
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
    configProject !== project ||
    !isWatch ||
    !process ||
    process.started !== identity.started ||
    process.command !== identity.command ||
    process.cwd !== identity.cwd ||
    !io.signalProcess ||
    !sameWatchLock(await readWatchLockInfo(paths, project), lock)
  ) {
    throw new Refusal(
      `cannot verify armada watch for ${project} (pid ${lock.pid}); left the process and lock untouched`,
      "armada watch --help",
    );
  }
  try {
    await io.signalProcess(lock.pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    await releaseWatchLock(paths, project, lock.pid, identity);
    print(null);
    return 0;
  }
  await releaseWatchLock(paths, project, lock.pid, identity);
  print(lock.pid);
  return 0;
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
  options: { follow: boolean; cursor?: string; kinds?: readonly string[]; tickets?: string[]; minutes?: number },
): Promise<number> {
  requireSignIn(credentials);
  const project = config.project.slug;
  const paths: MachinePaths | null = machinePaths(io.env);
  const pid = io.pid ?? process.pid;
  const controller = new AbortController();
  let stoppedBy: WatchSignal | null = null;
  let unsubscribe: (() => void) | undefined;
  let identity: WatchIdentity | undefined;
  let taken = false;
  let timedOut = false;
  let cancelDeadline: (() => void) | undefined;
  const until = options.minutes === undefined ? undefined : new Date(now(io).getTime() + options.minutes * 60000);
  const resume = () => {
    const flags = [
      "armada watch",
      ...(options.follow ? ["--follow"] : []),
      ...(options.cursor ? ["--since", options.cursor] : []),
      ...(options.tickets ? ["--tickets", options.tickets.join(",")] : []),
      ...(options.kinds ? ["--kinds", options.kinds.join(",")] : []),
      ...(json ? ["--json"] : []),
    ];
    io.stderr(`${options.follow ? "" : `no new item in ${options.minutes} min; `}resume: ${flags.join(" ")}\n`);
  };
  try {
    unsubscribe = io.onSignal?.((signal) => {
      if (stoppedBy) return;
      stoppedBy = signal;
      controller.abort(new Error("watch stopped"));
    });
    controller.signal.throwIfAborted();
    const inspected = await io.inspectProcess?.(pid);
    identity = inspected ? { ...inspected, project, configPath } : undefined;
    controller.signal.throwIfAborted();
    if (paths) {
      const lock = await takeWatchLock(paths, project, pid, alive(io), identity, options.follow ? "follow" : undefined);
      taken = lock.taken;
      controller.signal.throwIfAborted();
      if (!lock.taken) {
        const mode = (await readWatchLockInfo(paths, project))?.mode;
        const line =
          mode === "follow"
            ? `armada watch is following for ${project} (pid ${lock.pid}).`
            : `armada watch is already running for ${project} (pid ${lock.pid}): its output arrives when it ends.`;
        if (options.follow) io.stderr(`${line}\n`);
        else io.stdout(json ? `${JSON.stringify({ project, running: lock.pid, line }, null, 2)}\n` : `${line}\n`);
        return 0;
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
    const { fleet, warning } = liveFleet(watchingIo, config, credentials);
    if (!fleet)
      throw new Refusal(`the inbox is on Armada, which cannot be reached: ${warning ?? "no answer"}`, "armada whoami");
    const before = paths ? await readWatchState(paths, project) : null;
    await remember(io, project, { root: dirname(configPath), stopped: null });
    if (until && !io.sleep)
      cancelDeadline = watchDeadline(
        until,
        () => now(io),
        () => {
          timedOut = true;
          controller.abort(new Error("watch duration ended"));
        },
      );
    const common: FollowOptions = {
      until,
      project,
      signal: controller.signal,
      coordinator: coordinatorHandle(io),
      facts: detectCoordinator(io),
      silentAfterMinutes: config.policy.silentAfterMinutes,
      quietAfterMinutes: config.policy.quietAfterMinutes,
      notStartedMinutes: config.policy.notStartedMinutes,
      seen: before?.seen ?? [],
      now: io.now ?? (() => new Date()),
      sleep:
        io.sleep ??
        ((ms) =>
          new Promise<void>((done) => {
            const timer = setTimeout(finish, ms);
            function finish() {
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", finish);
              done();
            }
            controller.signal.addEventListener("abort", finish, { once: true });
          })),
      onRead: async ({ inFlight }) => {
        if (inFlight) await remember(io, project, { inFlight, readAt: now(io).toISOString() });
      },
      onRetry: (message) => io.stderr(`armada: warning: ${message}\n`),
      release: pendingRelease(watchingIo, version, before?.seen ?? []),
    };
    if (options.follow) {
      const cursor = options.cursor ?? before?.cursor ?? eventCursor(0, now(io).toISOString());
      const differentCursor = !!options.cursor && options.cursor !== before?.cursor;
      const eventIds = differentCursor ? [] : (before?.eventIds ?? []);
      const seen = differentCursor ? [] : (before?.seen ?? []);
      await remember(io, project, { cursor, eventIds, seen });
      io.stderr(
        `following ${project} as ${coordinatorHandle(io) ?? "coordinator"} from ${cursor}; stop: armada watch --stop --project ${project}\n`,
      );
      for await (const line of followFleet(observingFleet(watchingIo, fleet, config), {
        ...common,
        cursor,
        freshStart: !options.cursor && !before?.cursor,
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
            : `${line.at.slice(11, 16)} UTC ${line.kind} ${line.ticket ?? "-"} [#${line.id ?? "-"}] ${line.body.split(/\r?\n/)[0]}${line.new ? "" : " (open)"} cursor: ${line.cursor}\n`,
        );
        // Advance the explicit resume argument too, so a timed run never replays its start cursor.
        options.cursor = line.cursor;
        if (line.kind === "version" && typeof line.id === "string")
          await rememberRelease(io, line.id.slice("version:".length));
      }
      timedOut = !!until && now(io) >= until;
      if (timedOut) resume();
      return 0;
    }
    const report = await watchInbox(observingFleet(watchingIo, fleet, config), common);
    if (report.outcome === "timeout") {
      resume();
      return 0;
    }
    await remember(io, project, shown(io, report.items, report.inFlight));
    for (const e of report.items) if (e.kind === "version" && e.version) await rememberRelease(io, e.version);
    controller.signal.throwIfAborted();
    // A release is acted on between rounds: it is not an item that keeps a watch going.
    const open = report.items.filter((e) => e.kind !== "version").length;
    const next = rearm({ inFlight: report.inFlight, open, running: null, act: true });
    if (json) io.stdout(`${JSON.stringify({ ...report, watch: next }, null, 2)}\n`);
    else {
      const out =
        report.outcome === "nothing"
          ? [`Nothing to watch on ${project}: no worker in flight and nothing open.`]
          : [...renderEntries(project, report.items), "New items are marked *.", next.line];
      io.stdout(`${out.join("\n")}\n`);
    }
    for (const w of report.warnings) io.stderr(`armada: warning: ${w}\n`);
  } catch (err) {
    if (!stoppedBy && !timedOut) throw err;
    if (timedOut) resume();
  } finally {
    if (paths && taken) await releaseWatchLock(paths, project, pid, identity).catch(() => {});
    unsubscribe?.();
    cancelDeadline?.();
  }
  if (stoppedBy) {
    (options.follow ? io.stderr : io.stdout)(`armada watch for ${project} stopped by ${stoppedBy} (pid ${pid})\n`);
    return stoppedBy === "SIGINT" ? 130 : stoppedBy === "SIGTERM" ? 143 : 129;
  }
  return 0;
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
  try {
    let input: { cwd?: unknown } = {};
    try {
      input = JSON.parse((await io.readStdin?.()) || "{}") as { cwd?: unknown };
    } catch {}
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : io.cwd;
    const { path, text } = await findConfig({ ...io, cwd });
    const project = parseConfig(text, path).project.slug;
    const { state, running } = await watchOf(io, project);
    const d = stopHookDecision({ project, root: dirname(path), state, watching: running, env: io.env });
    if (d.block) io.stdout(`${JSON.stringify({ decision: "block", reason: d.reason })}\n`);
  } catch {}
  return 0;
}
