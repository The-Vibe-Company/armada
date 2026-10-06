import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machinePaths, recordClaim, updateWatchState } from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, fakeArmada, fakeClock, NOW } from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function terminal() {
  const home = await mkdtemp(join(tmpdir(), "armada-heartbeat-"));
  directories.push(home);
  const clock = fakeClock(NOW);
  const store = memoryFleet();
  const api = fakeArmada({ keys: { armada_key_CANARY_heartbeat: "heartbeat" }, clock, store });
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: "/work/widgets",
    env: { XDG_CONFIG_HOME: home, ARMADA_API_URL: ARMADA_URL, ARMADA_API_KEY: "armada_key_CANARY_heartbeat" },
    readFile: async (path) => (path === "/work/widgets/armada.toml" ? DEMO_TOML : null),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ghToken: () => null,
    fetch: api.fetch,
    now: clock.now,
    sleep: clock.sleep,
    pid: 12345,
    processAlive: (pid) => pid === 12345 || clock.now().getTime() < NOW.getTime() + 11 * 60_000,
    linearWriter: () => {
      throw new Error("heartbeat must never touch Linear");
    },
  };
  await recordClaim(
    store,
    "widgets",
    {
      ticket: "DEMO-7",
      runtime: "Conductor",
      handle: "workspace/session",
      branch: null,
      phase: "implementing",
      resuming: false,
      profile: null,
    },
    NOW,
  );
  return { io, clock, store, api, out, err };
}

const args = ["heartbeat", "--every", "5m", "--ticket", "DEMO-7", "--handle", "workspace/session", "--parent", "4242"];

describe("armada heartbeat", () => {
  test("only fleet pings on schedule, no Linear/key calls or secret output; exits with parent and cleans the PID file", async () => {
    const setup = await terminal();
    expect(await run(args, setup.io)).toBe(0);
    expect(setup.api.calls.map((call) => call.path)).toEqual(["fleet/heartbeat", "fleet/heartbeat", "fleet/heartbeat"]);
    expect(setup.store.events.filter((event) => event.kind === "heartbeat").map((event) => event.at)).toEqual(
      [NOW, new Date(NOW.getTime() + 300_000), new Date(NOW.getTime() + 600_000)].map((time) => time.toISOString()),
    );
    expect(setup.out.join("") + setup.err.join("")).toBe("");
    expect(await readdir(join(setup.io.env.XDG_CONFIG_HOME as string, "armada", "watch"))).toEqual([]);
  });

  test("background startup waits for readiness, passes no secret arguments, and falls back to manual reports", async () => {
    const setup = await terminal();
    let launched: string[] = [];
    setup.io.startBackground = async (parameters) => {
      launched = parameters;
      return true;
    };
    expect(await run([...args, "--background"], setup.io)).toBe(0);
    expect(launched).not.toContain("--background");
    expect(launched.join(" ")).not.toContain("CANARY");
    expect(launched).toContain("4242");
    expect(setup.api.calls).toEqual([]);
    setup.io.startBackground = async () => false;
    expect(await run([...args, "--background"], setup.io)).toBe(1);
    setup.io.startBackground = async () => {
      throw new Error("CANARY spawn unavailable");
    };
    expect(await run([...args, "--background"], setup.io)).toBe(1);
    expect(setup.err.join("")).not.toContain("CANARY");
    expect(setup.err.join("")).toContain("report manually at least every 15 minutes");
  });

  test("a detached heartbeat keeps the project selected from an unrelated folder", async () => {
    const setup = await terminal();
    const paths = machinePaths(setup.io.env);
    if (!paths) throw new Error("temporary machine store missing");
    await updateWatchState(paths, "widgets", { root: setup.io.cwd });
    setup.io.cwd = "/tmp";
    setup.io.startBackground = async (parameters) => {
      // Run the real child dispatch against the fake clock and fleet, from the same unrelated cwd.
      expect(await run(parameters, setup.io)).toBe(0);
      return true;
    };
    expect(await run([...args, "--project", "widgets", "--background"], setup.io)).toBe(0);
    expect(setup.api.calls.map((call) => call.path)).toEqual(["fleet/heartbeat", "fleet/heartbeat", "fleet/heartbeat"]);
  });

  test("unsafe interval or transient shell PID is refused before any API call", async () => {
    const setup = await terminal();
    expect(await run([...args, "--every", "0m"], setup.io)).toBe(2);
    expect(await run([...args, "--every", "16m"], setup.io)).toBe(2);
    expect(await run([...args, "--parent", "1"], setup.io)).toBe(2);
    expect(setup.api.calls).toEqual([]);
  });
});
