import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPublished,
  machinePaths,
  NPM_REGISTRY_URL,
  readWatchLock,
  readWatchLockInfo,
  readWatchState,
  type ServerCli,
  takeWatchLock,
  updateWatchState,
  type WatchIdentity,
  watchFiles,
} from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, fakeArmada, fakeClock, NOW } from "../../core/test/support.ts";
import { version } from "../package.json" with { type: "json" };
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
async function coordinator(o: { key?: string; cli?: ServerCli } = {}) {
  const home = await mkdtemp(join(tmpdir(), "armada-watch-"));
  dirs.push(home);
  const store = memoryFleet();
  const clock = fakeClock();
  const armada = fakeArmada({ keys: { [KEY]: "fleet" }, store, clock, ...(o.cli ? { cli: o.cli } : {}) });
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
  const identity = (project = P): WatchIdentity => ({
    project,
    configPath: `${COORDINATOR_ROOT}/armada.toml`,
    started: "synthetic-start-1",
    command: "/usr/bin/node /usr/local/bin/armada watch",
    cwd: COORDINATOR_ROOT,
  });

  test("stop verifies the holder and signals only this project's watch, without sign-in or network", async () => {
    const c = await coordinator();
    await takeWatchLock(c.paths, P, 101, () => false, identity());
    await takeWatchLock(c.paths, "gears", 202, () => false, identity("gears"));
    c.alive.add(101);
    c.alive.add(202);
    const killed: number[] = [];
    const io: Io = {
      ...c.io,
      env: { XDG_CONFIG_HOME: c.io.env.XDG_CONFIG_HOME },
      fetch: async () => {
        throw new Error("stop must not use the network");
      },
      ghToken: () => {
        throw new Error("stop must not resolve credentials");
      },
      inspectProcess: async (pid) => {
        expect(pid).toBe(101);
        return identity();
      },
      signalProcess: (pid, signal) => {
        expect(signal).toBe("SIGTERM");
        killed.push(pid);
      },
    };
    expect(await run(["watch", "--stop"], io)).toBe(0);
    expect(killed).toEqual([101]);
    expect(c.out()).toBe("Stopped armada watch for widgets (pid 101).\n");
    expect(await readWatchLock(c.paths, P)).toBeNull();
    expect(await readWatchLock(c.paths, "gears")).toBe(202);
    c.reset();
    expect(await run(["watch", "--stop", "--json"], io)).toBe(0);
    expect(JSON.parse(c.out())).toMatchObject({ project: P, stopped: null, line: "no watch running for widgets" });
  });

  test("stop recognizes source and bundled watches with global options before the command", async () => {
    for (const command of [
      "/usr/bin/bun packages/cli/src/main.ts --json watch",
      "/usr/bin/node /usr/local/bin/armada --config /work/widgets/armada.toml watch",
    ]) {
      const c = await coordinator();
      const held = { ...identity(), command };
      await takeWatchLock(c.paths, P, 101, () => false, held);
      c.alive.add(101);
      c.io.inspectProcess = async () => held;
      const killed: number[] = [];
      c.io.signalProcess = (pid) => {
        killed.push(pid);
      };
      expect(await run(["watch", "--stop"], c.io)).toBe(0);
      expect(killed).toEqual([101]);
    }
  });

  test("stop clears a dead lock, but never signals a legacy, reused, other-project or non-watch PID", async () => {
    for (const kind of [
      "dead",
      "legacy",
      "reused",
      "project",
      "command",
      "cwd",
      "unknown",
      "config",
      "non-watch",
    ] as const) {
      const c = await coordinator();
      await takeWatchLock(c.paths, P, 101, () => false, kind === "legacy" ? undefined : identity());
      if (kind !== "dead") c.alive.add(101);
      const io: Io = {
        ...c.io,
        inspectProcess: async () =>
          kind === "unknown"
            ? null
            : {
                ...identity(),
                ...(kind === "reused" ? { started: "synthetic-start-2" } : {}),
                ...(kind === "command" ? { command: "/usr/bin/node service.js" } : {}),
                ...(kind === "cwd" ? { cwd: "/work/gears" } : {}),
              },
        signalProcess: () => {
          throw new Error("must never signal this PID");
        },
      };
      if (kind === "config" || kind === "non-watch") {
        await writeFile(
          watchFiles(c.paths, P).lock,
          JSON.stringify({
            pid: 101,
            identity: {
              ...identity(),
              ...(kind === "config"
                ? { configPath: "/work/gears/armada.toml" }
                : { command: "/usr/bin/node service.js" }),
            },
          }),
        );
        if (kind === "non-watch")
          io.inspectProcess = async () => ({ ...identity(), command: "/usr/bin/node service.js" });
      }
      if (kind === "project") {
        await writeFile(watchFiles(c.paths, P).lock, JSON.stringify({ pid: 101, identity: identity("gears") }));
      }
      expect(await run(["watch", "--stop"], io)).toBe(kind === "dead" ? 0 : 1);
      if (kind === "dead") {
        expect(c.out()).toBe("no watch running for widgets\n");
        expect(await readWatchLock(c.paths, P)).toBeNull();
      } else {
        expect(c.err()).toContain("cannot verify armada watch for widgets (pid 101)");
        expect(await readWatchLock(c.paths, P)).toBe(101);
      }
    }
  });

  test("stop keeps the lock on kill failure and preserves a replacement holder", async () => {
    const c = await coordinator();
    await takeWatchLock(c.paths, P, 101, () => false, identity());
    c.alive.add(101);
    c.io.inspectProcess = async () => identity();
    c.io.signalProcess = () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    };
    expect(await run(["watch", "--stop"], c.io)).toBe(1);
    expect(await readWatchLock(c.paths, P)).toBe(101);
    c.io.signalProcess = async () => {
      await writeFile(
        watchFiles(c.paths, P).lock,
        JSON.stringify({ pid: 101, identity: { ...identity(), started: "replacement-start" } }),
      );
    };
    expect(await run(["watch", "--stop"], c.io)).toBe(0);
    expect((await readWatchLockInfo(c.paths, P))?.identity?.started).toBe("replacement-start");
  });

  test("stop refuses a holder replaced during inspection and handles a process gone before signalling", async () => {
    const c = await coordinator();
    await takeWatchLock(c.paths, P, 101, () => false, identity());
    c.alive.add(101);
    c.io.inspectProcess = async () => {
      await writeFile(watchFiles(c.paths, P).lock, JSON.stringify({ pid: 202, identity: identity() }));
      return identity();
    };
    c.io.signalProcess = () => {
      throw new Error("must never signal the replaced holder");
    };
    expect(await run(["watch", "--stop"], c.io)).toBe(1);
    expect(await readWatchLock(c.paths, P)).toBe(202);
    await writeFile(watchFiles(c.paths, P).lock, JSON.stringify({ pid: 101, identity: identity() }));
    c.io.inspectProcess = async () => identity();
    c.io.signalProcess = () => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    };
    c.reset();
    expect(await run(["watch", "--stop"], c.io)).toBe(0);
    expect(c.out()).toBe("no watch running for widgets\n");
    expect(await readWatchLock(c.paths, P)).toBeNull();
  });

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    for (const during of ["request", "sleep"] as const) {
      test(`${signal} during ${during} prints one shutdown line and releases only its lock`, async () => {
        const c = await coordinator();
        await c.hold("DEMO-2");
        await takeWatchLock(c.paths, "gears", 202, () => false);
        let listener: ((signal: "SIGTERM" | "SIGINT" | "SIGHUP") => void) | undefined;
        let removed = false;
        c.io.onSignal = (handler) => {
          listener = handler;
          return () => {
            removed = true;
          };
        };
        c.io.inspectProcess = async () => {
          const { started, command, cwd } = identity();
          return { started, command, cwd };
        };
        const fire = async () => {
          expect(await readWatchLockInfo(c.paths, P)).toEqual({ pid: 4242, identity: identity() });
          listener?.(signal);
          listener?.(signal);
          return new Promise<never>(() => {});
        };
        if (during === "request") {
          const fetch = c.io.fetch;
          if (!fetch) throw new Error("missing fake fetch");
          c.io.fetch = async (url, init) => (url.endsWith("/fleet/inbox") ? fire() : fetch(url, init));
        } else c.io.sleep = fire;
        expect(await run(["watch"], c.io)).toBe(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
        expect(c.out()).toBe(`armada watch for widgets stopped by ${signal} (pid 4242)\n`);
        expect(c.err()).toBe("");
        expect(await readWatchLock(c.paths, P)).toBeNull();
        expect(await readWatchLock(c.paths, "gears")).toBe(202);
        expect(removed).toBe(true);
      });
    }
  }

  test("a release with a delayed tarball ends the watch only after verification, once, and no notice repeats it", async () => {
    const server = { minimum: "0.0.1", latest: version };
    const c = await coordinator({ cli: server });
    const tarball = "https://registry.npmjs.org/armada-99.1.0.tgz";
    let ready = false;
    c.onSleep.push(
      async () => {
        expect(
          await checkPublished("99.1.0", async (url) =>
            url === NPM_REGISTRY_URL
              ? Response.json({ versions: { "99.1.0": { dist: { tarball } } } })
              : new Response(null, { status: ready ? 200 : 404 }),
          ),
        ).toEqual({ state: "missing", newest: null });
        expect(c.out()).not.toContain("is out");
      },
      async () => {
        ready = true;
        const answer = await checkPublished("99.1.0", async (url) =>
          url === NPM_REGISTRY_URL
            ? Response.json({ versions: { "99.1.0": { dist: { tarball } } } })
            : new Response(null, { status: ready ? 200 : 404 }),
        );
        if (answer.state === "published") server.latest = "99.1.0";
      },
    );
    await c.hold("DEMO-2");
    expect(await run(["watch"], c.io)).toBe(0);
    expect(c.out()).toBe(
      [
        "Inbox of widgets (1), oldest first:",
        `* version · ${new Date(NOW.getTime() + 30_000).toISOString()}`,
        `    Armada 99.1.0 is out (you run ${version}). Changes: https://github.com/The-Vibe-Company/armada/releases/tag/v99.1.0`,
        "    Not urgent: finish what is in flight first, then, between rounds:",
        "      1. npm install -g @the-vibe-company/armada@99.1.0",
        "      2. armada init, then merge its pull request: armada merge <n> --no-ticket",
        "    Workers in flight keep the version their brief pinned: tell them nothing unless the notes say otherwise.",
        "New items are marked *.",
        "1 worker in flight (DEMO-2) — act on the items above, then keep watching: armada watch",
        "",
      ].join("\n"),
    );
    expect(c.err()).toBe("");

    // The next watch waits for what is new to the coordinator: the release is not.
    c.reset();
    c.onSleep.push(async () => {
      await c.store.putHandBack({ project: P, ticket: "DEMO-2", author: null, body: "PR #4", at: c.clock.now() });
    });
    expect(await run(["watch"], c.io)).toBe(0);
    expect(c.out()).toContain("* #1 hand-back · DEMO-2");
    expect(c.out()).not.toContain("version");
    expect(c.err()).toBe("");
  });

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
      // A hand-back's key follows its text: handed back on a new head, it wakes the watch again.
      seen: [expect.stringMatching(/^#1@/)],
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

    // Signed out: refused before any read, and recorded so the stop hook stops asking.
    c.reset();
    delete c.io.env.ARMADA_API_KEY;
    expect(await run(["watch"], c.io)).toBe(2);
    expect((await readWatchState(c.paths, P))?.stopped).toContain("not signed in to Armada");
    expect(await hook(c, COORDINATOR_ROOT)).toBeNull();
    expect(await run(["inbox"], { ...c.io, env: { ...c.io.env, ARMADA_API_KEY: KEY } })).toBe(0);
    expect((await readWatchState(c.paths, P))?.stopped).toBeNull();
    expect(await hook(c, COORDINATOR_ROOT)).not.toBeNull();

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
