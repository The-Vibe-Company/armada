import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machinePaths, readWatchState, takeWatchLock, updateWatchState, watchFiles } from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, fakeArmada, fakeClock, NOW } from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";

const KEY = "armada_key_CANARY_watch";
const P = "widgets";
const COORDINATOR_ROOT = "/work/widgets";
const WORKER_ROOT = "/work/widgets-demo-2";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A coordinator's terminal on a fresh machine store, signed in to the fake Armada; `alive` lists the running pids. */
async function coordinator(o: { key?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "armada-watch-"));
  dirs.push(home);
  const store = memoryFleet();
  const clock = fakeClock();
  const armada = fakeArmada({ keys: { [KEY]: "fleet" }, store, clock });
  const out: string[] = [];
  const err: string[] = [];
  const alive = new Set<number>();
  const onSleep: (() => Promise<void>)[] = [];
  const io: Io = {
    cwd: COORDINATOR_ROOT,
    env: {
      XDG_CONFIG_HOME: home,
      ARMADA_API_URL: ARMADA_URL,
      ARMADA_API_KEY: o.key ?? KEY,
      ARMADA_COORDINATOR_HANDLE: "ws-coordinator/session",
    },
    readFile: async (path) =>
      path === `${COORDINATOR_ROOT}/armada.toml` || path === `${WORKER_ROOT}/armada.toml` ? DEMO_TOML : null,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    fetch: armada.fetch,
    now: clock.now,
    sleep: async (ms) => {
      await clock.sleep(ms);
      const next = onSleep.shift();
      if (!next) throw new Error("the watch kept waiting after the last scripted change");
      await next();
    },
    pid: 4242,
    processAlive: (pid) => alive.has(pid),
  };
  const paths = machinePaths(io.env);
  if (!paths) throw new Error("no machine store");
  const hold = async (ticket: string) => {
    await store.saveRuntimeHandle({
      project: P,
      ticket,
      runtime: "conductor",
      handle: `ws/${ticket}`,
      branch: null,
      at: clock.now(),
    });
    await store.recordEvent({ project: P, ticket, kind: "claim", phase: "planning", at: clock.now() });
  };
  const reset = () => {
    out.length = 0;
    err.length = 0;
  };
  return { io, store, clock, paths, alive, onSleep, hold, reset, out: () => out.join(""), err: () => err.join("") };
}

/** `armada hook stop` as Claude Code runs it: the hook's input on standard input. */
async function hook(c: Awaited<ReturnType<typeof coordinator>>, cwd: string, env: Record<string, string> = {}) {
  c.reset();
  const io: Io = {
    ...c.io,
    cwd: "/",
    env: { ...c.io.env, ...env },
    readStdin: async () => JSON.stringify({ session_id: "s", cwd, hook_event_name: "Stop", stop_hook_active: true }),
  };
  expect(await run(["hook", "stop"], io)).toBe(0);
  const text = c.out();
  return text ? (JSON.parse(text) as { decision: string; reason: string }) : null;
}

describe("armada watch", () => {
  test("watches until a hand-back, prints it with the re-arm line, and leaves the state for the stop hook", async () => {
    const c = await coordinator();
    await c.hold("DEMO-2");
    await c.hold("DEMO-3");
    c.onSleep.push(
      async () => {},
      async () => {
        await c.store.putHandBack({
          project: P,
          ticket: "DEMO-2",
          author: null,
          body: "Agent status: ready-to-merge — PR #4",
          at: c.clock.now(),
        });
      },
    );

    expect(await run(["watch"], c.io)).toBe(0);
    expect(c.out()).toBe(
      [
        "Inbox of widgets (1), oldest first:",
        `* #1 hand-back · DEMO-2 · ${new Date(NOW.getTime() + 30_000).toISOString()}`,
        "    Agent status: ready-to-merge — PR #4",
        "New items are marked *.",
        "2 workers in flight (DEMO-2, DEMO-3) — act on the items above, then keep watching: armada watch",
        "",
      ].join("\n"),
    );
    expect(c.err()).toBe("");
    expect(await readWatchState(c.paths, P)).toEqual({
      root: COORDINATOR_ROOT,
      seen: ["#1"],
      inFlight: ["DEMO-2", "DEMO-3"],
      readAt: new Date(NOW.getTime() + 30_000).toISOString(),
      stopped: null,
    });
    // The lock is given back.
    expect(await readFile(watchFiles(c.paths, P).lock, "utf8").catch(() => null)).toBeNull();

    // The stop hook: blocks in the coordinator's checkout, even when it already blocked once (stop_hook_active).
    const blocked = await hook(c, COORDINATOR_ROOT);
    expect(blocked?.decision).toBe("block");
    expect(blocked?.reason).toContain("2 workers in flight on widgets (DEMO-2, DEMO-3) and no armada watch is running");
    expect(blocked?.reason).toContain("(ARMADA_STOP_HOOK=off turns this hook off.)");
    // Never in a worker's checkout, never when turned off.
    expect(await hook(c, WORKER_ROOT)).toBeNull();
    expect(await hook(c, COORDINATOR_ROOT, { ARMADA_STOP_HOOK: "off" })).toBeNull();
    // Nor outside a repository Armada runs.
    expect(await hook(c, "/elsewhere")).toBeNull();

    // A watch runs again: the hand-back already shown does not wake it; the hook lets the turn end.
    expect(await takeWatchLock(c.paths, P, 777, () => false)).toEqual({ taken: true });
    c.alive.add(777);
    expect(await hook(c, COORDINATOR_ROOT)).toBeNull();
    c.reset();
    expect(await run(["watch"], c.io)).toBe(0);
    expect(c.out()).toBe("armada watch is already running for widgets (pid 777): its output arrives when it ends.\n");
    expect(await run(["inbox"], c.io)).toBe(0);
    expect(c.out().trimEnd().split("\n").at(-1)).toBe(
      "2 workers in flight (DEMO-2, DEMO-3) — act on the items above, then armada watch is already running (pid 777).",
    );

    // That watch was killed: its lock is stale, and the next watch takes it over.
    c.alive.delete(777);
    expect(await hook(c, COORDINATOR_ROOT)).not.toBeNull();
    c.onSleep.push(async () => {
      await c.store.releaseRuntimeHandle(P, "DEMO-3", c.clock.now());
      await c.store.resolveInboxItems({
        project: P,
        ticket: "DEMO-2",
        kind: "hand-back",
        resolution: "merged",
        at: c.clock.now(),
      });
      await c.store.releaseRuntimeHandle(P, "DEMO-2", c.clock.now());
    });
    c.reset();
    expect(await run(["watch"], c.io)).toBe(0);
    expect(c.out()).toBe("Nothing to watch on widgets: no worker in flight and nothing open.\n");
    expect((await readWatchState(c.paths, P))?.inFlight).toEqual([]);
    expect(await hook(c, COORDINATOR_ROOT)).toBeNull();
  });

  test("Armada down does not end the watch; a refusal does, and the stop hook then lets the turn end", async () => {
    const c = await coordinator();
    await c.hold("DEMO-2");
    let asks = 0;
    const fetch = c.io.fetch;
    c.io.fetch = async (url, init) => {
      if (url.endsWith("/fleet/inbox") && ++asks === 2)
        return Response.json({ error: "Armada is restarting" }, { status: 503 });
      return fetch?.(url, init) ?? Response.error();
    };
    c.onSleep.push(
      async () => {},
      async () => {},
      async () => {
        await c.store.addInboxItem({
          project: P,
          ticket: "DEMO-2",
          kind: "question",
          recipient: "coordinator",
          author: "ws/DEMO-2",
          body: "Which table?",
          at: c.clock.now(),
        });
      },
    );
    expect(await run(["watch"], c.io)).toBe(0);
    expect(c.err()).toBe("armada: warning: Armada refused: Armada is restarting; still watching, next try in 15 s\n");
    expect(c.out()).toContain("* #1 question · DEMO-2 · from ws/DEMO-2");

    c.reset();
    c.io.env.ARMADA_API_KEY = "armada_key_REVOKED";
    expect(await run(["watch"], c.io)).toBe(1);
    expect(c.err()).toContain("not signed in to Armada");
    expect((await readWatchState(c.paths, P))?.stopped).toContain("not signed in to Armada");
    expect(await hook(c, COORDINATOR_ROOT)).toBeNull();
  });

  test("a hook that cannot read its input or its state lets the turn end", async () => {
    const c = await coordinator();
    await updateWatchState(c.paths, P, { root: COORDINATOR_ROOT, inFlight: ["DEMO-2"] });
    expect(await hook(c, COORDINATOR_ROOT)).not.toBeNull();
    await writeFile(watchFiles(c.paths, P).state, "{ not json");
    expect(await hook(c, COORDINATOR_ROOT)).toBeNull();
    c.reset();
    // No input: the session's own directory, which holds no armada.toml here.
    expect(await run(["hook", "stop"], { ...c.io, cwd: "/", readStdin: async () => "not json" })).toBe(0);
    expect(c.out()).toBe("");
  });
});
