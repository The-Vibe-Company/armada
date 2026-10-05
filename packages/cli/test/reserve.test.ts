import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machinePaths, updateWatchState } from "../../core/src/index.ts";
import { ARMADA_URL, DEMO_TOML, fakeArmada, NOW } from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function terminal() {
  const dir = await mkdtemp(join(tmpdir(), "armada-reserve-"));
  dirs.push(dir);
  const api = fakeArmada({ keys: { armada_key_CANARY_reserve: "reserve" } });
  const out: string[] = [],
    err: string[] = [];
  const io: Io = {
    cwd: "/work/widgets",
    env: { XDG_CONFIG_HOME: dir, ARMADA_API_KEY: "armada_key_CANARY_reserve", ARMADA_API_URL: ARMADA_URL },
    readFile: async (p) => (p === "/work/widgets/armada.toml" ? DEMO_TOML : null),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    gitBranch: () => "feature/demo-7-shared-resources",
    fetch: api.fetch,
    now: () => NOW,
    linearWriter: () => {
      throw new Error("reservations never call Linear");
    },
  };
  return {
    io,
    api,
    out,
    err,
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

test("CLI allocates numbers, names and exclusive keys; lists holders and only unreserves the selected ticket", async () => {
  const t = await terminal();
  expect(await run(["reserve", "db-migration", "--next", "--floor", "22"], t.io)).toBe(0);
  expect(t.out.join("")).toBe("23\n");
  t.reset();
  expect(await run(["reserve", "db-migration", "--next", "--floor", "22", "--ticket", "DEMO-8"], t.io)).toBe(0);
  expect(t.out.join("")).toBe("24\n");
  t.reset();
  expect(await run(["reserve", "fixture", "--value", "sample", "--note", "shared fixture"], t.io)).toBe(0);
  t.reset();
  expect(await run(["reserve", "fixture", "--value", "sample", "--ticket", "DEMO-8"], t.io)).toBe(2);
  expect(t.err.join("")).toContain("held by DEMO-7");
  t.reset();
  expect(await run(["reserve", "release"], t.io)).toBe(0);
  t.reset();
  expect(await run(["reserve", "--list"], t.io)).toBe(0);
  expect(t.out.join("")).toContain("db-migration = 23 · DEMO-7");
  expect(t.out.join("")).toContain("fixture = sample · DEMO-7 · shared fixture");
  expect(t.out.join("")).toContain("release (exclusive) · DEMO-7");
  t.reset();
  expect(await run(["unreserve", "fixture", "--ticket", "DEMO-8"], t.io)).toBe(0);
  expect(t.out.join("")).toContain("Freed 0");
  t.reset();
  expect(await run(["unreserve", "fixture"], t.io)).toBe(0);
  expect(t.out.join("")).toContain("Freed 1");
  expect(t.api.calls.every((c) => c.path.startsWith("fleet/"))).toBe(true);
});

test("allocation flag mistakes are refused before writes; outages fail clearly without a Linear fallback", async () => {
  const t = await terminal();
  for (const flags of [
    ["--next", "--value", "23"],
    ["--floor", "22"],
    ["--next", "--floor", "-1"],
    ["--next", "--floor", "1.5"],
  ])
    expect(await run(["reserve", "db-migration", ...flags], t.io)).toBe(2);
  expect(t.api.calls.length).toBe(0);
  t.reset();
  t.io.fetch = async () => {
    throw new Error("offline");
  };
  expect(await run(["reserve", "db-migration", "--next"], t.io)).toBe(2);
  expect(t.err.join("")).toContain("Ask the coordinator");
  expect(t.err.join("")).toContain("no Linear fallback");
});

test("reservation commands honor the watched project selector away from its checkout", async () => {
  const t = await terminal();
  const paths = machinePaths(t.io.env);
  if (!paths) throw new Error("missing temporary machine paths");
  await updateWatchState(paths, "widgets", { root: "/work/widgets" });
  t.io.cwd = "/tmp";
  expect(await run(["reserve", "fixture", "--project", "widgets", "--note", "selected project"], t.io)).toBe(0);
  t.reset();
  expect(await run(["reserve", "--list", "--project", "widgets"], t.io)).toBe(0);
  expect(t.out.join("")).toContain("selected project");
  t.reset();
  expect(await run(["unreserve", "fixture", "--project", "widgets"], t.io)).toBe(0);
  expect(t.out.join("")).toContain("Freed 1");
});
