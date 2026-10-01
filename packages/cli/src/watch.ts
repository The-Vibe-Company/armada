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
  readWatchState,
  rearm,
  releaseWatchLock,
  runningWatch,
  stopHookDecision,
  takeWatchLock,
  updateWatchState,
  type WatchState,
  watchInbox,
} from "@armada/core";
import { renderEntries } from "./inbox.ts";
import { type Io, UsageError } from "./io.ts";
import { requireSignIn } from "./login.ts";
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
  requireSignIn(credentials);
  const { fleet, warning } = liveFleet(io, config, credentials);
  if (!fleet)
    throw new Refusal(`the inbox is on Armada, which cannot be reached: ${warning ?? "no answer"}`, "armada whoami");
  const project = config.project.slug;
  const paths: MachinePaths | null = machinePaths(io.env);
  const pid = io.pid ?? process.pid;
  if (paths) {
    const lock = await takeWatchLock(paths, project, pid, alive(io));
    if (!lock.taken) {
      const line = `armada watch is already running for ${project} (pid ${lock.pid}): its output arrives when it ends.`;
      io.stdout(a.json ? `${JSON.stringify({ project, running: lock.pid, line }, null, 2)}\n` : `${line}\n`);
      return 0;
    }
  }
  try {
    const before = paths ? await readWatchState(paths, project) : null;
    await remember(io, project, { root: dirname(configPath), stopped: null });
    let report: Awaited<ReturnType<typeof watchInbox>>;
    try {
      report = await watchInbox(fleet, {
        project,
        coordinator: coordinatorHandle(io),
        silentAfterMinutes: config.policy.silentAfterMinutes,
        seen: before?.seen ?? [],
        now: io.now ?? (() => new Date()),
        sleep: io.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))),
        onRead: async ({ inFlight }) => {
          if (inFlight) await remember(io, project, { inFlight, readAt: now(io).toISOString() });
        },
        onRetry: (message) => io.stderr(`armada: warning: ${message}\n`),
      });
    } catch (err) {
      // The stop hook stops asking for a watch that cannot run (signed out, refused).
      await remember(io, project, { stopped: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    await remember(io, project, shown(io, report.items, report.inFlight));
    const next = rearm({ inFlight: report.inFlight, open: report.items.length, running: null, act: true });
    if (a.json) io.stdout(`${JSON.stringify({ ...report, watch: next }, null, 2)}\n`);
    else {
      const out =
        report.outcome === "nothing"
          ? [`Nothing to watch on ${project}: no worker in flight and nothing open.`]
          : [...renderEntries(project, report.items), "New items are marked *."];
      if (report.outcome === "items") out.push(next.line);
      io.stdout(`${out.join("\n")}\n`);
    }
    for (const w of report.warnings) io.stderr(`armada: warning: ${w}\n`);
    return 0;
  } finally {
    if (paths) await releaseWatchLock(paths, project, pid).catch(() => {});
  }
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
