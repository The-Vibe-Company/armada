import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machinePaths, planSkills, releasesFile } from "@armada/core";
import { NOW } from "../../core/test/support.ts";
import { heard } from "../src/api.ts";
import type { Io } from "../src/io.ts";
import { noticeRelease, pendingRelease } from "../src/release.ts";
import { applyPlan, fsRepoView } from "../src/repo.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function terminal() {
  const cwd = await mkdtemp(join(tmpdir(), "armada-release-"));
  dirs.push(cwd);
  const err: string[] = [];
  let at = NOW;
  const io: Io = {
    cwd,
    env: { XDG_CONFIG_HOME: cwd },
    readFile: async () => null,
    stdout: () => {},
    stderr: (s) => err.push(s),
    ghToken: () => null,
    now: () => at,
  };
  const server = { minimum: "0.1.0", latest: "1.2.4" };
  heard(io).server = server;
  const view = fsRepoView(cwd);
  await applyPlan(cwd, await planSkills(view, "1.2.3"));
  return {
    io,
    server,
    cwd,
    view,
    err,
    time: (ms: number) => {
      at = new Date(NOW.getTime() + ms);
    },
  };
}

test("ordinary releases never interrupt watch; notices are daily across versions and repeat after 24 hours", async () => {
  const c = await terminal();
  expect(await pendingRelease(c.io, "1.2.3")()).toBeNull();
  await noticeRelease(c.io, "1.2.3", c.view);
  expect(c.err).toHaveLength(1);
  expect(c.err[0]).not.toContain("armada init");
  c.server.latest = "1.2.5";
  c.time(86_400_000 - 1);
  await noticeRelease(c.io, "1.2.3", c.view);
  expect(c.err).toHaveLength(1);
  c.time(86_400_000);
  await noticeRelease(c.io, "1.2.3", c.view);
  expect(c.err).toHaveLength(2);
  expect(c.err[1]).toContain("1.2.5");
  c.time(2 * 86_400_000);
  await noticeRelease(c.io, "1.2.3", c.view);
  expect(c.err).toHaveLength(3);
});

test("a minimum-version refusal remains required after a quiet notice and without a machine store", async () => {
  const c = await terminal();
  await noticeRelease(c.io, "1.2.3", c.view);
  c.server.minimum = "1.2.4";
  c.io.env = {};
  const entry = await pendingRelease(c.io, "1.2.3")();
  expect(entry).toMatchObject({ kind: "version", version: "1.2.4" });
  expect(entry?.body).toContain("server requires");
  expect(entry?.body).not.toContain("armada init");
});

for (const name of ["armada-worker", "review-code-dev"]) {
  test(`${name} setup drift is a daily notice even without a newer release`, async () => {
    const c = await terminal();
    c.server.latest = "1.2.3";
    await writeFile(join(c.cwd, `.agents/skills/${name}/SKILL.md`), "outdated instructions");
    expect(await pendingRelease(c.io, "1.2.3")()).toBeNull();
    await noticeRelease(c.io, "1.2.3", c.view);
    expect(c.err).toEqual([
      "armada: This project's Armada setup is behind 1.2.3: armada upgrade, then merge the setup pull request it opens.\n",
    ]);
    await noticeRelease(c.io, "1.2.3", c.view);
    expect(c.err).toHaveLength(1);
    c.time(86_400_000);
    await noticeRelease(c.io, "1.2.3", c.view);
    expect(c.err).toHaveLength(2);
  });
}

test("setup notices have a separate daily budget and stay quiet without machine storage", async () => {
  const c = await terminal();
  await noticeRelease(c.io, "1.2.3", c.view);
  await writeFile(join(c.cwd, ".agents/skills/armada-worker/SKILL.md"), "outdated instructions");
  await noticeRelease(c.io, "1.2.3", c.view);
  expect(c.err).toHaveLength(2);
  expect(c.err[1]).toContain("setup is behind 1.2.4");
  c.server.latest = "1.2.5";
  await noticeRelease(c.io, "1.2.3", c.view);
  expect(c.err).toHaveLength(2);
  c.io.env = {};
  c.time(86_400_000);
  await noticeRelease(c.io, "1.2.3", c.view);
  expect(c.err).toHaveLength(2);
});

test("legacy release memory migrates without suppressing notices forever; workers stay quiet", async () => {
  const c = await terminal();
  const paths = machinePaths(c.io.env);
  if (!paths) throw new Error("no machine store");
  await mkdir(paths.dir, { recursive: true });
  await writeFile(releasesFile(paths), JSON.stringify({ noticed: ["1.2.4"] }));
  await noticeRelease(c.io, "1.2.3", c.view);
  expect(c.err).toHaveLength(1);
  c.io.env.ARMADA_TICKET = "DEMO-2";
  c.time(86_400_000);
  await noticeRelease(c.io, "1.2.3", c.view);
  expect(c.err).toHaveLength(1);
  expect(await pendingRelease(c.io, "1.2.3")()).toBeNull();
});

test("concurrent commands reserve only one daily notice across versions", async () => {
  const c = await terminal();
  const other: Io = { ...c.io };
  heard(other).server = { minimum: "0.1.0", latest: "1.2.5" };
  await Promise.all([noticeRelease(c.io, "1.2.3", c.view), noticeRelease(other, "1.2.3", c.view)]);
  expect(c.err).toHaveLength(1);
});
