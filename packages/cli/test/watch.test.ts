import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  machinePaths,
  parseConfig,
  planSkills,
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
import { ARMADA_URL, DEMO_TOML, fakeArmada, fakeClock, NOW, tempFleet } from "../../core/test/support.ts";
import { version } from "../package.json" with { type: "json" };
import { type Io, run } from "../src/cli.ts";
import { refreshingJobsFleet } from "../src/job.ts";
import { applyPlan, fsRepoView } from "../src/repo.ts";
import { rearmFor, watchDeadline } from "../src/watch.ts";

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
  const armada = fakeArmada({
    keys: { [KEY]: "fleet" },
    store,
    clock,
    ...(o.cli ? { cli: o.cli } : {}),
  });
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
      LINEAR_API_KEY: "synthetic-watch-key",
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
  test("named watch defaults to mine, all opts out, and unnamed watch retains the full fleet", async () => {
    const c = await coordinator();
    await c.store.saveRuntimeHandle({
      project: P,
      ticket: "DEMO-8",
      coordinator: "default",
      runtime: "conductor",
      handle: "ws/other",
      branch: null,
      at: NOW,
    });
    await c.store.putHandBack({ project: P, ticket: "DEMO-8", author: null, body: "PR #8", at: NOW });
    c.io.env.ARMADA_COORDINATOR = "front";
    expect(await run(["watch", "--json"], c.io)).toBe(0);
    expect(JSON.parse(c.out())).toMatchObject({ outcome: "nothing", inFlight: [] });
    c.reset();
    c.onSleep.push(async () => {
      await c.store.addInboxItem({
        project: P,
        ticket: "DEMO-9",
        kind: "question",
        recipient: "coordinator",
        author: null,
        body: "Unowned question",
        at: c.clock.now(),
      });
    });
    expect(await run(["watch", "--all", "--json"], c.io)).toBe(0);
    expect(JSON.parse(c.out())).toMatchObject({
      outcome: "items",
      inFlight: ["DEMO-8"],
      watch: { inFlight: [], open: 1 },
      items: [
        { ticket: "DEMO-8", owner: "default" },
        { ticket: "DEMO-9", owner: null },
      ],
    });
    c.reset();
    delete c.io.env.ARMADA_COORDINATOR;
    expect(await run(["watch", "--json"], c.io)).toBe(0);
    expect(JSON.parse(c.out())).toMatchObject({ outcome: "items", inFlight: ["DEMO-8"] });
    c.reset();
    expect(await run(["inbox", "--mine", "--all"], c.io)).toBe(2);
    expect(c.err()).toContain("choose --mine or --all");
  });

  test("named inbox defaults to all, mine labels owned/unowned entries and keeps an owned re-arm count", async () => {
    const c = await coordinator();
    c.io.env.ARMADA_COORDINATOR = "front";
    for (const [ticket, owner] of [
      ["DEMO-7", "front"],
      ["DEMO-8", "default"],
      ["DEMO-9", null],
    ] as const) {
      await c.store.saveRuntimeHandle({
        project: P,
        ticket,
        coordinator: owner,
        runtime: "conductor",
        handle: `ws/${ticket}`,
        branch: null,
        at: NOW,
      });
      await c.store.putHandBack({ project: P, ticket, author: null, body: "PR #7", at: NOW });
    }
    expect(await run(["inbox", "--json"], c.io)).toBe(0);
    expect(JSON.parse(c.out())).toMatchObject({
      inFlight: ["DEMO-7", "DEMO-8", "DEMO-9"],
      watch: { inFlight: ["DEMO-7"] },
    });
    c.reset();
    expect(await run(["inbox", "--mine"], c.io)).toBe(0);
    expect(c.out()).toContain("DEMO-7 · owner: front");
    expect(c.out()).toContain("DEMO-9 · unowned");
    expect(c.out()).not.toContain("DEMO-8");
    expect((await readWatchState(c.paths, P, "front"))?.inFlight).toEqual(["DEMO-7"]);
  });

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
      "/usr/bin/node /usr/local/bin/armada --project widgets watch --follow",
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

  for (const follow of [false, true]) {
    test(`ordinary releases leave ${follow ? "follow" : "plain"} watch running until real work arrives`, async () => {
      const server = { minimum: "0.0.1", latest: version };
      const c = await coordinator({ cli: server });
      await c.hold("DEMO-2");
      c.onSleep.push(
        async () => {
          server.latest = "99.1.0";
        },
        async () => {
          expect(c.out()).not.toContain("version");
          await c.store.putHandBack({ project: P, ticket: "DEMO-2", author: null, body: "PR #4", at: c.clock.now() });
        },
        async () => {},
      );
      expect(await run(follow ? ["watch", "--follow", "--for", "0.75", "--json"] : ["watch"], c.io)).toBe(0);
      expect(c.out()).toContain("hand-back");
      expect(c.out()).not.toContain("version");
      expect(c.err()).not.toContain("is out");
    });

    test(`a server minimum interrupts ${follow ? "follow" : "plain"} watch with a version item`, async () => {
      const server = { minimum: "0.0.1", latest: "99.1.0" };
      const c = await coordinator({ cli: server });
      await c.hold("DEMO-2");
      c.onSleep.push(async () => {
        server.minimum = "99.0.0";
      });
      expect(
        await run(
          follow ? ["watch", "--follow", "--tickets", "DEMO-2", "--kinds", "hand-back", "--json"] : ["watch", "--json"],
          c.io,
        ),
      ).toBe(0);
      expect(c.out()).toContain('"kind": "version"'.replaceAll(" ", follow ? "" : " "));
      expect(c.out()).toContain("server requires Armada 99.0.0");
      expect(c.out()).not.toContain("armada init");
      expect(await readWatchLock(c.paths, P)).toBeNull();
    });
  }

  test("setup behind leaves plain watch waiting and notices are shared with inbox", async () => {
    const c = await coordinator({ cli: { minimum: "0.0.1", latest: version } });
    const root = join(c.io.env.XDG_CONFIG_HOME ?? "", "checkout");
    await applyPlan(root, await planSkills(fsRepoView(root), version));
    await writeFile(join(root, ".agents/skills/armada-worker/SKILL.md"), "outdated instructions");
    c.io.cwd = root;
    c.io.readFile = async (path) => (path === join(root, "armada.toml") ? DEMO_TOML : null);
    await c.hold("DEMO-2");
    c.onSleep.push(async () => {});
    expect(await run(["watch", "--for", "0.25", "--json"], c.io)).toBe(0);
    expect(c.out()).toBe("");
    expect(c.err()).toContain(
      `This project's Armada setup is behind ${version}: armada upgrade, then merge the setup pull request it opens.`,
    );
    expect(c.err()).toContain("resume: armada watch");
    c.reset();
    expect(await run(["inbox"], c.io)).toBe(0);
    expect(c.err()).toBe("");
    c.clock.advance(86_400_000);
    c.reset();
    expect(await run(["inbox"], c.io)).toBe(0);
    expect(c.err()).toContain("setup is behind");
    expect(c.err()).not.toContain("required");
  });

  test("a timer-aborted plain watch still prints its setup notice", async () => {
    const c = await coordinator({ cli: { minimum: "0.0.1", latest: version } });
    const root = join(c.io.env.XDG_CONFIG_HOME ?? "", "checkout");
    await applyPlan(root, await planSkills(fsRepoView(root), version));
    await writeFile(join(root, ".agents/skills/armada-worker/SKILL.md"), "outdated instructions");
    c.io.cwd = root;
    c.io.readFile = async (path) => (path === join(root, "armada.toml") ? DEMO_TOML : null);
    c.io.sleep = undefined;
    let expire: (() => void) | undefined;
    const schedule = globalThis.setTimeout;
    const timer = schedule(() => {}, 2 ** 31 - 1);
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(
      Object.assign(
        (handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
          if (ms !== 15000) return schedule(handler, ms, ...args);
          expire = () => handler(...args);
          return timer;
        },
        { __promisify__: schedule.__promisify__ },
      ) as typeof setTimeout,
    );
    const fetch = c.io.fetch;
    if (!fetch) throw new Error("missing fake API");
    c.io.fetch = async (url, init) => {
      if (url.endsWith("/fleet/inbox")) {
        expect(expire).toBeDefined();
        c.clock.advance(15000);
        expire?.();
      }
      return fetch(url, init);
    };
    try {
      expect(await run(["watch", "--for", "0.25"], c.io)).toBe(0);
      expect(c.out()).toBe("");
      expect(c.err()).toContain("resume: armada watch");
      expect(c.err()).toContain(
        `This project's Armada setup is behind ${version}: armada upgrade, then merge the setup pull request it opens.`,
      );
      expect(await readWatchLock(c.paths, P)).toBeNull();
    } finally {
      timers.mockRestore();
      clearTimeout(timer);
    }
  });

  test("shown inbox history is bounded to the newest 500 entries in oldest-first order", async () => {
    const c = await coordinator();
    for (let i = 0; i < 501; i++)
      await c.store.addInboxItem({
        project: P,
        ticket: "DEMO-9",
        kind: "note",
        recipient: "coordinator",
        author: null,
        body: `Note ${i}`,
        at: c.clock.now(),
      });
    expect(await run(["inbox", "--json"], c.io)).toBe(0);
    const items = JSON.parse(c.out()).items;
    expect(items).toHaveLength(501);
    expect((await readWatchState(c.paths, P))?.seen).toEqual(
      items.slice(1).map((item: { id: number }) => `#${item.id}`),
    );
  });

  test("inbox between watches keeps an already shown minimum-version notice quiet", async () => {
    const server = { minimum: "99.0.0", latest: "99.1.0" };
    const c = await coordinator({ cli: server });
    await c.hold("DEMO-2");
    expect(await run(["watch", "--json"], c.io)).toBe(0);
    expect(JSON.parse(c.out()).items).toMatchObject([
      { kind: "version", new: true, body: expect.stringContaining(`Armada 99.0.0 required (you run ${version})`) },
    ]);
    // A normal inbox read cannot list the watch's synthetic version entry.
    server.minimum = "0.0.1";
    for (let i = 0; i < 501; i++)
      await c.store.addInboxItem({
        project: P,
        ticket: "DEMO-9",
        kind: "note",
        recipient: "coordinator",
        author: null,
        body: `Note ${i}`,
        at: c.clock.now(),
      });
    c.reset();
    expect(await run(["inbox"], c.io)).toBe(0);
    const state = await readWatchState(c.paths, P);
    expect(state?.seen).toHaveLength(500);
    expect(state?.seen.some((key) => key.startsWith("version:"))).toBe(true);
    server.minimum = "99.0.0";
    c.reset();
    c.onSleep.push(async () => {});
    expect(await run(["watch", "--for", "0.25", "--json"], c.io)).toBe(0);
    expect(c.out()).toBe("");
    expect(c.err()).toContain("resume: armada watch");
  });

  test("mine inbox preserves broader shown history until an all read prunes it", async () => {
    const c = await coordinator();
    await c.store.saveRuntimeHandle({
      project: P,
      ticket: "DEMO-8",
      coordinator: "front",
      runtime: "conductor",
      handle: "ws/DEMO-8",
      branch: null,
      at: NOW,
    });
    const other = await c.store.addInboxItem({
      project: P,
      ticket: "DEMO-8",
      kind: "plan",
      recipient: "coordinator",
      author: null,
      body: "Other coordinator's plan",
      at: NOW,
    });
    await c.store.addInboxItem({
      project: P,
      ticket: "DEMO-9",
      kind: "question",
      recipient: "coordinator",
      author: null,
      body: "Unowned question",
      at: NOW,
    });
    expect(await run(["inbox", "--all", "--json"], c.io)).toBe(0);
    expect(JSON.parse(c.out()).watch.open).toBe(1);
    const first = (await readWatchState(c.paths, P))?.seen;
    expect(first).toHaveLength(2);
    await c.store.resolveInboxItem({ project: P, id: other, resolution: "answered", at: NOW });
    c.reset();
    expect(await run(["inbox", "--mine"], c.io)).toBe(0);
    expect((await readWatchState(c.paths, P))?.seen).toEqual(first);
    expect((await readWatchState(c.paths, P))?.seenScope).toBe("all");
    c.reset();
    expect(await run(["inbox", "--all"], c.io)).toBe(0);
    expect((await readWatchState(c.paths, P))?.seen).toHaveLength(1);
  });

  test("a server already requiring a newer CLI returns a version item on the first read", async () => {
    const c = await coordinator({ cli: { minimum: "99.0.0", latest: "99.1.0" } });
    expect(await run(["watch", "--json"], c.io)).toBe(0);
    expect(JSON.parse(c.out()).items).toMatchObject([{ kind: "version", version: "99.1.0" }]);
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
        `* #1 hand-back · DEMO-2 · unowned · ${new Date(NOW.getTime() + 30_000).toISOString()}`,
        "    Agent status: ready-to-merge — PR #4",
        "    shipping path unreported",
        "New items are marked *.",
        "2 workers in flight (DEMO-2, DEMO-3) — act on the items above, then keep watching: armada watch",
        "",
      ].join("\n"),
    );
    expect(c.err()).toBe("");
    expect(await readWatchState(c.paths, P)).toEqual({
      openJobs: [],
      root: COORDINATOR_ROOT,
      // A hand-back's key follows its text: handed back on a new head, it wakes the watch again.
      seen: [expect.stringMatching(/^#1@/)],
      seenScope: "all",
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
    expect(c.out()).toContain("* #1 question · DEMO-2 · unowned · from ws/DEMO-2");

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

test("two named coordinators watch one project concurrently and each wakes for its own item", async () => {
  const c = await coordinator();
  for (const [ticket, name] of [
    ["DEMO-2", "front"],
    ["DEMO-3", "back"],
  ] as const) {
    await c.hold(ticket);
    expect(await c.store.transferTickets({ project: P, tickets: [ticket], to: name, at: NOW })).toBe(true);
  }
  const start = (name: string, pid: number) => {
    let wake: (() => void) | undefined;
    let ready: (() => void) | undefined;
    const sleeping = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const output: string[] = [];
    c.alive.add(pid);
    const io: Io = {
      ...c.io,
      pid,
      env: { ...c.io.env, ARMADA_COORDINATOR: name },
      stdout: (text) => output.push(text),
      sleep: () =>
        new Promise<void>((resolve) => {
          wake = resolve;
          ready?.();
        }),
    };
    return { done: run(["watch", "--json"], io), sleeping, wake: () => wake?.(), output };
  };
  const front = start("front", 4242);
  await front.sleeping;
  const back = start("back", 4343);
  await back.sleeping;
  expect(await readWatchLock(c.paths, P, "front")).toBe(4242);
  expect(await readWatchLock(c.paths, P, "back")).toBe(4343);
  for (const ticket of ["DEMO-2", "DEMO-3"])
    await c.store.addInboxItem({
      project: P,
      ticket,
      kind: "question",
      recipient: "coordinator",
      author: ticket,
      body: `Question for ${ticket}`,
      at: NOW,
    });
  front.wake();
  back.wake();
  expect(await front.done).toBe(0);
  expect(await back.done).toBe(0);
  expect(JSON.parse(front.output.join("")).items.map((item: { ticket: string }) => item.ticket)).toEqual(["DEMO-2"]);
  expect(JSON.parse(back.output.join("")).items.map((item: { ticket: string }) => item.ticket)).toEqual(["DEMO-3"]);
  expect((await readWatchState(c.paths, P, "front"))?.inFlight).toEqual(["DEMO-2"]);
  expect((await readWatchState(c.paths, P, "back"))?.inFlight).toEqual(["DEMO-3"]);
});

test("follow NDJSON streams both items, persists, times out cleanly and shares the watch lock", async () => {
  const c = await coordinator();
  await c.hold("DEMO-2");
  c.onSleep.push(
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
    async () => {
      await c.store.putHandBack({ project: P, ticket: "DEMO-2", author: null, body: "PR #4", at: c.clock.now() });
    },
    async () => {},
    async () => {},
  );
  expect(await run(["watch", "--follow", "--all", "--json", "--for", "1"], c.io)).toBe(0);
  const lines = c
    .out()
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  expect(lines.map((l) => l.kind)).toEqual(["question", "hand-back"]);
  expect(lines.every((l) => /^v1\./.test(l.cursor))).toBe(true);
  expect(c.err()).toContain("resume: armada watch --follow");
  expect(c.err()).toContain("--project widgets");
  expect(await readWatchLock(c.paths, P)).toBeNull();
  expect((await readWatchState(c.paths, P))?.seen).toHaveLength(2);
  c.reset();
  c.onSleep.push(async () => {});
  const cursor = (await readWatchState(c.paths, P))?.cursor;
  if (!cursor) throw new Error("follow did not save its cursor");
  expect(await run(["watch", "--follow", "--json", "--since", cursor, "--for", "0.25"], c.io)).toBe(0);
  expect(c.out()).toBe("");
  await takeWatchLock(c.paths, P, 777, () => false, undefined, "follow");
  c.alive.add(777);
  c.reset();
  expect(await run(["watch"], c.io)).toBe(0);
  expect(c.out()).toContain("following for widgets (pid 777)");
  c.reset();
  expect(await run(["watch", "--follow", "--json"], c.io)).toBe(0);
  expect(c.out()).toBe("");
  expect(c.err()).toContain("following for widgets (pid 777)");
});

test("plain watch accepts a bounded lifetime and follow refuses unsupported or malformed filters", async () => {
  const c = await coordinator();
  await c.hold("DEMO-2");
  c.onSleep.push(
    async () => {},
    async () => {},
    async () => {},
    async () => {},
  );
  expect(await run(["watch", "--for", "1"], c.io)).toBe(0);
  expect(c.err()).toContain("no new item in 1 min; resume: armada watch");
  for (const flags of [
    ["--follow", "--kinds", "typo"],
    ["--follow", "--since", "bad"],
    ["--follow", "--tickets", "bad"],
    ["--for", "0"],
    ["--mine", "--all"],
  ]) {
    c.reset();
    expect(await run(["watch", ...flags], c.io)).toBe(2);
  }
  expect(c.err()).toContain("choose --mine or --all");
});

test("long watch deadlines are chunked below Node's timer limit and cancellable", () => {
  let at = 0,
    expired = 0;
  const calls: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const stop = watchDeadline(
    new Date(31536000000),
    () => new Date(at),
    () => {
      expired++;
    },
    (run, ms) => {
      const call = { run, ms, cancelled: false };
      calls.push(call);
      return () => {
        call.cancelled = true;
      };
    },
  );
  const first = calls[0];
  if (!first) throw new Error("no timer");
  expect(first.ms).toBe(2 ** 31 - 1);
  at = first.ms;
  first.run();
  expect(expired).toBe(0);
  expect(calls).toHaveLength(2);
  const next = calls[1];
  if (!next) throw new Error("no re-armed timer");
  at = 31536000000;
  next.run();
  expect(expired).toBe(1);
  stop();
  expect(next.cancelled).toBe(true);
});

test("plain and follow watch keep open jobs fresh, throttle across restarts, and let failed probes go silent", async () => {
  for (const follow of [false, true]) {
    const c = await coordinator();
    const configText = `${DEMO_TOML}\n[jobs.eval]\nstart = "start"\nstatus = "probe"\nstop = "stop"\nsilence_minutes = 15`;
    c.io.readFile = async (path) => (path === `${COORDINATOR_ROOT}/armada.toml` ? configText : null);
    const job = await c.store.startJob({
      project: P,
      ticket: "DEMO-7",
      name: "eval",
      startedBy: "runner",
      at: new Date(NOW.getTime() - 20 * 60000),
    });
    await c.store.observeJob({
      project: P,
      ticket: job.ticket,
      id: job.id,
      state: "running",
      ref: "run-1",
      progress: "1/120",
      at: new Date(NOW.getTime() - 20 * 60000),
    });
    let probes = 0;
    c.io.exec = async (command, args, opts) => {
      expect(command).toBe("sh");
      expect(args).toEqual(["-c", "probe"]);
      expect(opts).toMatchObject({
        cwd: COORDINATOR_ROOT,
        env: { ARMADA_JOB_ID: String(job.id), ARMADA_JOB_REF: "run-1" },
      });
      probes++;
      return { code: 0, stdout: "running 40/120", stderr: "private runner output" };
    };
    c.io.sleep = c.clock.sleep;
    const flags = follow ? ["--follow"] : [];
    expect(await run(["watch", ...flags, "--for", "1", "--json"], c.io)).toBe(0);
    expect(probes).toBe(1);
    expect((await c.store.getJob(P, job.id))?.progress).toBe("40/120");
    expect(c.out()).not.toContain("job-silent");
    c.reset();
    // A fresh invocation shares the machine throttle, including failed attempts.
    c.clock.advance(7 * 60000);
    c.io.exec = async () => {
      probes++;
      return { code: 1, stdout: "", stderr: "private runner output" };
    };
    expect(await run(["watch", ...flags, "--for", "1", "--json"], c.io)).toBe(0);
    expect(probes).toBe(2);
    expect((await c.store.getJob(P, job.id))?.progress).toBe("40/120");
    c.reset();
    expect(await run(["watch", ...flags, "--for", "1", "--json"], c.io)).toBe(0);
    expect(probes).toBe(2);
    c.reset();
    c.clock.advance(8 * 60000);
    expect(await run(["watch", ...flags, "--for", "1", "--json"], c.io)).toBe(0);
    expect(probes).toBe(3);
    expect(c.out()).toContain("job-silent");
    expect(c.out() + c.err()).not.toContain("private runner output");
  }
});

test("watch cancellation aborts a pending job status probe without a late observation or worker count", async () => {
  const c = await coordinator();
  c.io.readFile = async (path) =>
    path === `${COORDINATOR_ROOT}/armada.toml`
      ? `${DEMO_TOML}\n[jobs.eval]\nstart = "start"\nstatus = "probe"\nstop = "stop"`
      : null;
  const job = await c.store.startJob({
    project: P,
    ticket: "DEMO-7",
    name: "eval",
    startedBy: "runner",
    at: new Date(NOW.getTime() - 20 * 60000),
  });
  await c.store.observeJob({
    project: P,
    ticket: job.ticket,
    id: job.id,
    state: "running",
    ref: "run-1",
    at: new Date(NOW.getTime() - 20 * 60000),
  });
  let stop: (() => void) | undefined;
  c.io.onSignal = (handler) => {
    stop = () => handler("SIGINT");
    return () => {};
  };
  let aborted = false;
  c.io.exec = async (_command, _args, opts) => {
    expect(opts.signal).toBeDefined();
    opts.signal?.addEventListener("abort", () => {
      aborted = true;
    });
    stop?.();
    return { code: 1, stdout: "", stderr: "" };
  };
  expect(await run(["watch", "--json"], c.io)).toBe(130);
  expect(aborted).toBe(true);
  expect((await c.store.getJob(P, job.id))?.state).toBe("running");
  expect(await readWatchLock(c.paths, P)).toBeNull();
});

test("named follow watches retain independent cursors, seen items and resume roles", async () => {
  const c = await coordinator();
  for (const [ticket, name] of [
    ["DEMO-2", "front"],
    ["DEMO-3", "back"],
  ] as const) {
    await c.hold(ticket);
    await c.store.transferTickets({ project: P, tickets: [ticket], to: name, at: NOW });
    await c.store.addInboxItem({
      project: P,
      ticket,
      kind: "question",
      recipient: "coordinator",
      author: null,
      body: name,
      at: NOW,
    });
  }
  for (const [name, ticket] of [
    ["front", "DEMO-2"],
    ["back", "DEMO-3"],
  ] as const) {
    c.reset();
    c.io.env.ARMADA_COORDINATOR = name;
    c.onSleep.push(async () => {});
    expect(await run(["watch", "--follow", "--json", "--for", "0.25"], c.io)).toBe(0);
    expect(
      c
        .out()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).ticket),
    ).toEqual([ticket]);
    expect(c.err()).toContain(`resume: ARMADA_COORDINATOR=${name} armada watch --follow`);
    const state = await readWatchState(c.paths, P, name);
    expect(state?.cursor).toMatch(/^v1\./);
    expect(state?.seen).toHaveLength(1);
    expect(state?.inFlight).toEqual([ticket]);
  }
  expect((await readWatchState(c.paths, P, "front"))?.seen).not.toEqual(
    (await readWatchState(c.paths, P, "back"))?.seen,
  );
  expect(await readWatchState(c.paths, P)).toBeNull();
});

test("rearm keeps the named coordinator's cached jobs until a fresh reading clears them", async () => {
  const c = await coordinator();
  c.io.env.ARMADA_COORDINATOR = "back";
  await updateWatchState(c.paths, P, { inFlight: [], openJobs: [7], readAt: NOW.toISOString() }, "back");
  await updateWatchState(c.paths, P, { openJobs: [99] });
  const cached = await rearmFor(c.io, P, { inFlight: [], open: null });
  expect(cached.openJobs).toEqual([7]);
  expect(cached.line).toContain("1 open job (7)");
  const cleared = await rearmFor(c.io, P, { inFlight: [], open: null, openJobs: [] });
  expect(cleared.openJobs).toBeUndefined();
  expect(cleared.line).toContain("nothing to watch");
});

test("queued failed status probes throttle from their actual start across watch invocations", async () => {
  const c = await coordinator();
  const config = parseConfig(
    `${DEMO_TOML}\n[jobs.eval]\nstart = "start"\nstatus = "probe"\nstop = "stop"\nsilence_minutes = 1`,
  );
  const live = tempFleet({ store: c.store, clock: c.clock });
  for (let i = 0; i < 5; i++) {
    const job = await c.store.startJob({
      project: P,
      ticket: "DEMO-7",
      name: "eval",
      startedBy: null,
      at: new Date(NOW.getTime() - 20 * 60000),
    });
    await c.store.observeJob({
      project: P,
      ticket: job.ticket,
      id: job.id,
      ref: `run-${job.id}`,
      state: "running",
      at: new Date(NOW.getTime() - 20 * 60000),
    });
  }
  const calls: { id: number; at: number }[] = [];
  const pending: (() => void)[] = [];
  c.io.exec = async (_command, _args, options) => {
    calls.push({ id: Number(options.env?.ARMADA_JOB_ID), at: c.clock.now().getTime() - NOW.getTime() });
    if (calls.length <= 4)
      await new Promise<void>((resolve) => {
        pending.push(resolve);
        if (pending.length === 4) {
          c.clock.advance(60000);
          for (const finish of pending) finish();
        }
      });
    return { code: 1, stdout: "", stderr: "" };
  };
  const read = () =>
    refreshingJobsFleet(c.io, live.fleet, config, COORDINATOR_ROOT, new AbortController().signal).inbox({
      coordinator: null,
      silentAfterMinutes: 15,
      etag: null,
    });
  await read();
  expect(calls.filter((call) => call.id === 1).map((call) => call.at)).toEqual([60000]);
  expect((await readWatchState(c.paths, `${P}.job-observe`))?.jobObserved?.[1]).toBe(c.clock.now().toISOString());
  c.clock.advance(15000);
  await read();
  expect(calls).toHaveLength(9);
  expect(calls.filter((call) => call.id === 1).map((call) => call.at)).toEqual([60000]);
  c.clock.advance(15000);
  await read();
  expect(calls.filter((call) => call.id === 1).map((call) => call.at)).toEqual([60000, 90000]);
});

test("named inbox job liveness stays owned and mine probes preserve other coordinators' throttle", async () => {
  const c = await coordinator();
  c.io.env.ARMADA_COORDINATOR = "back";
  const configText = `${DEMO_TOML}\n[jobs.eval]\nstart = "start"\nstatus = "probe"\nstop = "stop"\nsilence_minutes = 15`;
  c.io.readFile = async (path) => (path === `${COORDINATOR_ROOT}/armada.toml` ? configText : null);
  const config = parseConfig(configText);
  const live = tempFleet({ store: c.store, clock: c.clock });
  const ids: number[] = [];
  for (const [ticket, coordinator] of [
    ["DEMO-7", "front"],
    ["DEMO-8", "back"],
    ["DEMO-9", null],
  ] as const) {
    if (coordinator)
      await c.store.saveRuntimeHandle({
        project: P,
        ticket,
        coordinator,
        runtime: "conductor",
        handle: `ws/${ticket}`,
        branch: null,
        at: NOW,
      });
    const job = await c.store.startJob({
      project: P,
      ticket,
      name: "eval",
      startedBy: null,
      at: new Date(NOW.getTime() - 20 * 60000),
    });
    await c.store.observeJob({
      project: P,
      ticket,
      id: job.id,
      state: "running",
      ref: `run-${job.id}`,
      at: new Date(NOW.getTime() - 20 * 60000),
    });
    ids.push(job.id);
  }
  expect(await run(["inbox", "--json"], c.io)).toBe(0);
  const read = JSON.parse(c.out());
  expect(read.openJobs).toEqual([...ids].reverse());
  expect(read.ownedOpenJobs).toEqual([ids[1]]);
  expect(read.watch.openJobs).toEqual([ids[1]]);
  expect((await readWatchState(c.paths, P, "back"))?.openJobs).toEqual([ids[1] as number]);
  await updateWatchState(c.paths, `${P}.job-observe`, { jobObserved: { [ids[0] as number]: NOW.toISOString() } });
  const probed: number[] = [];
  c.io.exec = async (_command, _args, options) => {
    probed.push(Number(options.env?.ARMADA_JOB_ID));
    return { code: 0, stdout: "running 40/120", stderr: "" };
  };
  const mine = await refreshingJobsFleet(
    c.io,
    live.fleet,
    config,
    COORDINATOR_ROOT,
    new AbortController().signal,
  ).inbox({ scope: "mine", coordinatorName: "back", coordinator: null, silentAfterMinutes: 15, etag: null });
  expect(probed).toEqual([ids[1] as number]);
  expect(mine?.openJobs).toEqual([ids[1] as number]);
  expect((await readWatchState(c.paths, `${P}.job-observe`))?.jobObserved?.[ids[0] as number]).toBe(NOW.toISOString());
});
