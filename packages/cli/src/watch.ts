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
  type InboxEntry,
  type MachinePaths,
  machinePaths,
  parseConfig,
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
import { coordinatorName, validCoordinator } from "./coordinator.ts";
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
    await updateWatchState(paths, project, patch, await coordinatorName(io, project));
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
  o: { inFlight: string[] | null; open: number | null; act?: boolean },
): Promise<Rearm> {
  const { running } = await watchOf(io, project);
  return rearm({ ...o, running });
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
    return await watchUntil(io, config, credentials, a.json, configPath);
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
        : `Stopped armada watch for ${project}${name === "default" ? "" : ` (${name})`} (pid ${pid}).`;
    io.stdout(json ? `${JSON.stringify({ project, coordinator: name, stopped: pid, line }, null, 2)}\n` : `${line}\n`);
  };
  if (!paths || !lock) {
    print(null);
    return 0;
  }
  if (!alive(io)(lock.pid)) {
    await releaseWatchLock(paths, project, lock.pid, lock.identity ?? undefined, name);
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
    /(?:^|\s)(?:\S*\/)?(?:armada(?:\.js)?|packages\/cli\/src\/(?:main|bin)\.ts)\s+(?:(?:--json|--all)\s+|--config(?:=\S+|\s+\S+)\s+)*watch(?:\s|$)/.test(
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
    !io.signalProcess ||
    !sameWatchLock(await readWatchLockInfo(paths, project, name), lock)
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
    await releaseWatchLock(paths, project, lock.pid, identity, name);
    print(null);
    return 0;
  }
  await releaseWatchLock(paths, project, lock.pid, identity, name);
  print(lock.pid);
  return 0;
}

async function watchUntil(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  json: boolean,
  configPath: string,
): Promise<number> {
  requireSignIn(credentials);
  const project = config.project.slug;
  const name = await coordinatorName(io, project, dirname(configPath));
  // The running watch keeps its role even if another terminal changes this checkout preference.
  io = { ...io, coordinatorRoot: dirname(configPath), env: { ...io.env, ARMADA_COORDINATOR: name } };
  const paths: MachinePaths | null = machinePaths(io.env);
  const pid = io.pid ?? process.pid;
  const controller = new AbortController();
  let stoppedBy: WatchSignal | null = null;
  let unsubscribe: (() => void) | undefined;
  let identity: WatchIdentity | undefined;
  let taken = false;
  try {
    unsubscribe = io.onSignal?.((signal) => {
      if (stoppedBy) return;
      stoppedBy = signal;
      controller.abort(new Error("watch stopped"));
    });
    controller.signal.throwIfAborted();
    const inspected = await io.inspectProcess?.(pid);
    identity = inspected
      ? { ...inspected, project, configPath, ...(name === "default" ? {} : { coordinatorName: name }) }
      : undefined;
    controller.signal.throwIfAborted();
    if (paths) {
      const lock = await takeWatchLock(paths, project, pid, alive(io), identity, name);
      taken = lock.taken;
      controller.signal.throwIfAborted();
      if (!lock.taken) {
        const line = `armada watch is already running for ${project} (pid ${lock.pid}): its output arrives when it ends.`;
        io.stdout(json ? `${JSON.stringify({ project, running: lock.pid, line }, null, 2)}\n` : `${line}\n`);
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
    const before = paths ? await readWatchState(paths, project, name) : null;
    await remember(io, project, { root: dirname(configPath), stopped: null });
    const report = await watchInbox(observingFleet(watchingIo, fleet, config), {
      project,
      signal: controller.signal,
      coordinator: coordinatorHandle(io),
      facts: { ...detectCoordinator(io), name },
      coordinatorName: name,
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
    });
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
    if (!stoppedBy) throw err;
  } finally {
    if (paths && taken) await releaseWatchLock(paths, project, pid, identity, name).catch(() => {});
    unsubscribe?.();
  }
  if (stoppedBy) {
    io.stdout(`armada watch for ${project} stopped by ${stoppedBy} (pid ${pid})\n`);
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
    const { state, running } = await watchOf({ ...io, coordinatorRoot: dirname(path) }, project);
    const d = stopHookDecision({ project, root: dirname(path), state, watching: running, env: io.env });
    if (d.block) io.stdout(`${JSON.stringify({ decision: "block", reason: d.reason })}\n`);
  } catch {}
  return 0;
}
