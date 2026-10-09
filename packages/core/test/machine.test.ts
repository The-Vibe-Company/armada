import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/config.ts";
import {
  addNoticedRelease,
  ensurePersonalConfig,
  machinePaths,
  noticesFile,
  parsePersonalConfig,
  readCoordinatorName,
  readCredentialStore,
  readReleaseNotices,
  readWatchState,
  releaseWatchLock,
  reserveNotice,
  runningWatch,
  storeIsExposed,
  takeWatchLock,
  updateCredentialStore,
  updateWatchState,
  watchFiles,
  writeCoordinatorName,
} from "../src/machine.ts";

test("notice reservations serialize commands, preserve releases, and recover a dead holder", async () => {
  const paths = machinePaths({ XDG_CONFIG_HOME: await tempHome() });
  if (!paths) throw new Error("no machine store");
  const at = new Date("2026-01-01T00:00:00Z");
  const intervalMs = 86_400_000;
  expect(
    (
      await Promise.all([
        addNoticedRelease(paths, "1.0.1", at, { intervalMs }),
        addNoticedRelease(paths, "1.0.2", at, { intervalMs }),
      ])
    ).filter(Boolean),
  ).toHaveLength(1);
  expect(await readReleaseNotices(paths)).toHaveLength(1);
  await writeFile(join(paths.dir, "releases.lock"), "9999\n");
  expect(
    await addNoticedRelease(paths, "1.0.3", new Date(at.getTime() + intervalMs), { intervalMs, alive: () => false }),
  ).toBe(true);
  expect((await readReleaseNotices(paths)).at(-1)).toEqual({ version: "1.0.3", at: "2026-01-02T00:00:00.000Z" });
  await writeFile(join(paths.dir, "releases.lock"), "9999\n");
  await writeFile(join(paths.dir, "releases.lock.cleanup"), "8888\n");
  expect(
    await addNoticedRelease(paths, "1.0.4", new Date(at.getTime() + 2 * intervalMs), {
      intervalMs,
      alive: () => false,
    }),
  ).toBe(false);
  expect(await readFile(join(paths.dir, "releases.lock"), "utf8")).toBe("9999\n");
});

test("notice keys migrate releases, throttle independently, persist forever, and fail closed on corrupt memory", async () => {
  const paths = machinePaths({ XDG_CONFIG_HOME: await tempHome() });
  if (!paths) throw new Error("no machine store");
  await addNoticedRelease(paths, "1.0.1", new Date("2026-01-01T00:00:00Z"));
  // Simulate an upgrade from the previous release-only format.
  await rm(noticesFile(paths), { force: true });
  await writeFile(
    join(paths.dir, "releases.json"),
    JSON.stringify({ noticed: ["0.9.0", { version: "1.0.1", at: "2026-01-01T00:00:00.000Z" }] }),
  );
  const at = new Date("2026-01-01T01:00:00Z");
  expect(await reserveNotice(paths, "hint:digest:widgets", at, 86_400_000)).toBe(true);
  expect(await readReleaseNotices(paths)).toEqual([
    { version: "0.9.0", at: null },
    { version: "1.0.1", at: "2026-01-01T00:00:00.000Z" },
  ]);
  expect(await addNoticedRelease(paths, "1.0.2", at, { intervalMs: 86_400_000 })).toBe(false);
  expect(await reserveNotice(paths, "hint:digest:widgets", at, 86_400_000)).toBe(false);
  expect(await reserveNotice(paths, "hint:digest:other", at, 86_400_000)).toBe(true);
  expect(await reserveNotice(paths, "session:once", at, Infinity)).toBe(true);
  const tomorrow = new Date(at.getTime() + 86_400_000);
  expect(await reserveNotice(paths, "hint:digest:widgets", tomorrow, 86_400_000)).toBe(true);
  expect(await reserveNotice(paths, "session:once", tomorrow, Infinity)).toBe(false);
  // An old CLI can still write the previous format after migration, under the same lock.
  await writeFile(
    join(paths.dir, "releases.json"),
    JSON.stringify({ noticed: [{ version: "1.0.1", at: "2026-01-02T00:00:00.000Z" }] }),
  );
  expect(await addNoticedRelease(paths, "1.0.2", tomorrow, { intervalMs: 86_400_000 })).toBe(false);
  expect((await readReleaseNotices(paths)).find((entry) => entry.version === "1.0.1")?.at).toBe(
    "2026-01-02T00:00:00.000Z",
  );
  const later = new Date("2026-01-03T00:00:00Z");
  expect(await addNoticedRelease(paths, "1.0.3", later, { intervalMs: 86_400_000 })).toBe(true);
  // New release reservations remain visible to old CLIs too.
  expect(JSON.parse(await readFile(join(paths.dir, "releases.json"), "utf8")).noticed.at(-1)).toEqual({
    version: "1.0.3",
    at: later.toISOString(),
  });

  expect(await reserveNotice(paths, "hint:digest:widgets", at, 86_400_000)).toBe(false);
  await writeFile(noticesFile(paths), "bad json");
  expect(await reserveNotice(paths, "hint:digest:widgets", tomorrow, 86_400_000)).toBe(false);
  expect(await readFile(noticesFile(paths), "utf8")).toBe("bad json");
  await rm(noticesFile(paths));
  await mkdir(noticesFile(paths));
  expect(await reserveNotice(paths, "hint:digest:widgets", tomorrow, 86_400_000)).toBe(false);
  await rm(noticesFile(paths), { recursive: true });
  await writeFile(join(paths.dir, "releases.json"), "bad json");
  expect(await reserveNotice(paths, "hint:digest:widgets", tomorrow, 86_400_000)).toBe(false);
});

test("a failed new receipt write leaves the release reservation visible to both CLI generations", async () => {
  const paths = machinePaths({ XDG_CONFIG_HOME: await tempHome() });
  if (!paths) throw new Error("no machine store");
  const at = new Date("2026-01-01T00:00:00Z");
  const rename = fs.rename;
  const failure = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === noticesFile(paths)) throw new Error("synthetic receipt rename failure");
    return rename(from, to);
  });
  try {
    expect(await addNoticedRelease(paths, "1.0.1", at, { intervalMs: 86_400_000 })).toBe(false);
    expect(JSON.parse(await readFile(join(paths.dir, "releases.json"), "utf8")).noticed).toEqual([
      { version: "1.0.1", at: at.toISOString() },
    ]);
  } finally {
    failure.mockRestore();
  }
  expect(await readReleaseNotices(paths)).toEqual([{ version: "1.0.1", at: at.toISOString() }]);
  expect(await addNoticedRelease(paths, "1.0.1", at, { intervalMs: 86_400_000 })).toBe(false);
});

const dirs: string[] = [];
const tempHome = async () => {
  const dir = await mkdtemp(join(tmpdir(), "armada-machine-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("the store lives under an absolute XDG_CONFIG_HOME, else ~/.config, else nowhere", () => {
  expect(machinePaths({ XDG_CONFIG_HOME: "/x", HOME: "/h" })?.credentials).toBe("/x/armada/credentials");
  expect(machinePaths({ XDG_CONFIG_HOME: "relative", HOME: "/h" })?.config).toBe("/h/.config/armada/config.toml");
  expect(machinePaths({})).toBeNull();
});

test("the credentials file is created 0600 in a 0700 directory and updated without losing lines", async () => {
  const paths = machinePaths({ XDG_CONFIG_HOME: await tempHome() });
  if (!paths) throw new Error("no paths");
  expect(await readCredentialStore(paths.credentials)).toMatchObject({ exists: false, values: {} });

  await updateCredentialStore(paths, { LINEAR_API_KEY: "lin_api_first" });
  expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
  expect((await stat(paths.credentials)).mode & 0o777).toBe(0o600);

  // A file someone wrote by hand, too open: the update keeps its content and closes it.
  await writeFile(paths.credentials, "# my keys\nLINEAR_API_KEY=lin_api_first\nOTHER_TOOL=keep\n");
  await chmod(paths.credentials, 0o644);
  const open = await readCredentialStore(paths.credentials);
  expect([open.mode, storeIsExposed(open)]).toEqual([0o644, true]);

  await updateCredentialStore(paths, { ARMADA_API_KEY: "armada_key_1" });
  expect(await readFile(paths.credentials, "utf8")).toBe(
    "# my keys\nLINEAR_API_KEY=lin_api_first\nOTHER_TOOL=keep\nARMADA_API_KEY=armada_key_1\n",
  );
  const after = await readCredentialStore(paths.credentials);
  expect([after.mode, storeIsExposed(after)]).toEqual([0o600, false]);
});

test("config.toml is created once from a commented template and parsed with the unknown-key rule", async () => {
  const paths = machinePaths({ HOME: await tempHome() });
  if (!paths) throw new Error("no paths");
  expect(await ensurePersonalConfig(paths)).toBe(true);
  expect(parsePersonalConfig(await readFile(paths.config, "utf8"))).toEqual({
    language: null,
    dashboard: { url: null },
    api: { url: null },
  });
  await writeFile(paths.config, 'language = "fr"\n');
  expect(await ensurePersonalConfig(paths)).toBe(false);
  expect(await readFile(paths.config, "utf8")).toBe('language = "fr"\n');

  expect(parsePersonalConfig('language = "fr"\n[api]\nurl = "https://armada.example.test"\n[later]\nx = 1\n')).toEqual({
    language: "fr",
    dashboard: { url: null },
    api: { url: "https://armada.example.test" },
  });
  const problems = (() => {
    try {
      parsePersonalConfig('stray = 1\n[api]\nurl = ""\ntoken = "no"\n');
    } catch (err) {
      if (err instanceof ConfigError) return err.problems;
    }
    return null;
  })();
  expect(problems).toEqual(['unknown key "stray"', 'unknown key "api.token"', '"api.url" must be a non-empty string']);
});

test("one watch per project: a live lock is refused, a stale one taken over, the state kept between runs", async () => {
  const paths = machinePaths({ XDG_CONFIG_HOME: await tempHome() });
  if (!paths) throw new Error("no paths");
  const live = new Set([101]);
  const alive = (pid: number) => live.has(pid);

  expect(await readWatchState(paths, "widgets")).toBeNull();
  expect(await takeWatchLock(paths, "widgets", 101, alive)).toEqual({ taken: true });
  expect(await takeWatchLock(paths, "widgets", 202, alive)).toEqual({ taken: false, pid: 101 });
  // Another project has its own lock.
  expect(await takeWatchLock(paths, "gears", 202, alive)).toEqual({ taken: true });
  expect(await runningWatch(paths, "widgets", alive)).toBe(101);

  // The first watch was killed without giving its lock back.
  live.delete(101);
  expect(await runningWatch(paths, "widgets", alive)).toBeNull();
  expect(await takeWatchLock(paths, "widgets", 303, alive)).toEqual({ taken: true });
  await releaseWatchLock(paths, "widgets", 101);
  expect((await readFile(watchFiles(paths, "widgets").lock, "utf8")).trim()).toBe("303");
  await releaseWatchLock(paths, "widgets", 303);
  expect(await runningWatch(paths, "widgets", alive)).toBeNull();

  await updateWatchState(paths, "widgets", { root: "/work/widgets", inFlight: ["DEMO-2"] });
  await updateWatchState(paths, "widgets", { seen: ["#4"] });
  expect(await readWatchState(paths, "widgets")).toEqual({
    root: "/work/widgets",
    seen: ["#4"],
    inFlight: ["DEMO-2"],
    readAt: null,
    stopped: null,
  });
  expect((await stat(watchFiles(paths, "widgets").state)).mode & 0o777).toBe(0o600);
  await writeFile(watchFiles(paths, "widgets").state, "not json");
  expect(await readWatchState(paths, "widgets")).toBeNull();
});

test("named coordinators keep independent watch locks, state and checkout preferences", async () => {
  const paths = machinePaths({ XDG_CONFIG_HOME: await tempHome() });
  if (!paths) throw new Error("no paths");
  const alive = () => true;
  expect(watchFiles(paths, "widgets", "default")).toEqual(watchFiles(paths, "widgets"));
  expect(await takeWatchLock(paths, "widgets", 101, alive, undefined, undefined, "front")).toEqual({ taken: true });
  expect(await takeWatchLock(paths, "widgets", 202, alive, undefined, undefined, "back")).toEqual({ taken: true });
  expect(await takeWatchLock(paths, "widgets", 303, alive, undefined, undefined, "front")).toEqual({
    taken: false,
    pid: 101,
  });
  await updateWatchState(paths, "widgets", { seen: ["front-item"], root: "/work/widgets" }, "front");
  await updateWatchState(paths, "widgets", { seen: ["back-item"] }, "back");
  expect((await readWatchState(paths, "widgets", "front"))?.seen).toEqual(["front-item"]);
  expect((await readWatchState(paths, "widgets", "back"))?.seen).toEqual(["back-item"]);
  await releaseWatchLock(paths, "widgets", 101, undefined, "front");
  expect(await runningWatch(paths, "widgets", alive, "back")).toBe(202);
  expect(await runningWatch(paths, "widgets", alive, "front")).toBeNull();
  await writeCoordinatorName(paths, "widgets", "/work/widgets", "front");
  await writeCoordinatorName(paths, "widgets", "/work/other", "back");
  expect(await readCoordinatorName(paths, "widgets", "/work/widgets")).toBe("front");
  expect(await readCoordinatorName(paths, "widgets", "/work/other")).toBe("back");
  expect(await readCoordinatorName(paths, "other", "/work/widgets")).toBeNull();
});
