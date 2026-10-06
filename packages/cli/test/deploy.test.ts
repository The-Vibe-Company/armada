import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, fakeArmada, fakeClock, NOW } from "../../core/test/support.ts";
import { loadCredentials } from "../src/auth.ts";
import { type Io, run } from "../src/cli.ts";
import { startDeploys } from "../src/deploy.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const sha = "a".repeat(40),
  live = "b".repeat(40);
const configText = `${DEMO_TOML}\n[[deploy.target]]\nname = "api"\nlive_sha_command = "version"\nsmoke = "health"\ntimeout_minutes = 1\n`;
async function terminal() {
  const dir = await mkdtemp(join(tmpdir(), "armada-deploy-"));
  dirs.push(dir);
  const clock = fakeClock(NOW),
    store = memoryFleet();
  const api = fakeArmada({ keys: { armada_key_CANARY_deploy: "deploy" }, clock, store });
  const out: string[] = [],
    err: string[] = [];
  const io: Io = {
    cwd: "/work/widgets",
    env: { XDG_CONFIG_HOME: dir, ARMADA_API_URL: ARMADA_URL, ARMADA_API_KEY: "armada_key_CANARY_deploy" },
    readFile: async (path) => (path === "/work/widgets/armada.toml" ? configText : null),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    fetch: api.fetch,
    now: clock.now,
    sleep: clock.sleep,
    pid: 12345,
    processAlive: () => true,
  };
  return { io, store, clock, out, err, api };
}

test("watch commands are bounded, run at repo root with deploy environment, and coalesce smoke", async () => {
  const t = await terminal();
  let smoke = 0;
  t.io.exec = async (command, args, options) => {
    expect(options.cwd).toBe("/work/widgets");
    if (command === "git") return { code: 0, stdout: "", stderr: "" };
    expect(command).toBe("sh");
    expect(options.processGroup).toBe(true);
    expect(options.env?.ARMADA_DEPLOY_TARGET).toBe("api");
    expect(options.timeoutMs).toBeLessThanOrEqual(60_000);
    if (args[1] === "version") return { code: 0, stdout: live, stderr: "" };
    expect(options.env?.ARMADA_DEPLOY_SHA).toBe(live);
    smoke++;
    return { code: 0, stdout: "health ok", stderr: "" };
  };
  expect(await run(["deploy", "watch", "--sha", sha, "--target", "api"], t.io)).toBe(0);
  expect(await run(["deploy", "watch", "--sha", "c".repeat(40), "--target", "api"], t.io)).toBe(0);
  expect(smoke).toBe(1);
  expect(await t.store.openHolds("widgets")).toHaveLength(0);
  expect((await t.store.deployState("widgets", { target: "api", sha }))[0]?.state).toBe("healthy");
  expect(t.out.join("") + t.err.join("")).not.toContain("CANARY");
});

test("failing smoke pauses merges and a healthy newer deploy recovers", async () => {
  const t = await terminal();
  let healthy = false;
  t.io.exec = async (command, args) => ({
    code: command === "git" || args[1] === "version" || healthy ? 0 : 1,
    stdout: args[1] === "version" ? (healthy ? live : sha) : "health output",
    stderr: "",
  });
  expect(await run(["deploy", "watch", "--sha", sha, "--target", "api"], t.io)).toBe(1);
  expect(await t.store.openHolds("widgets")).toHaveLength(1);
  healthy = true;
  expect(await run(["deploy", "watch", "--sha", live, "--target", "api"], t.io)).toBe(0);
  expect(await t.store.openHolds("widgets")).toHaveLength(0);
  expect(await t.store.openInboxItems({ project: "widgets", recipient: "coordinator" })).toHaveLength(0);
});

test("merge startup emits exact watch line or safe fallback without blocking on deploy", async () => {
  const t = await terminal();
  const credentials = (await loadCredentials(t.io, { armada: false })).credentials;
  let started: string[] = [];
  t.io.startBackground = async (args, options) => {
    started = args;
    expect(options?.logPath).toContain("/armada/watch/deploy-");
    return true;
  };
  await startDeploys(t.io, parseConfig(configText), credentials, "/work/widgets/armada.toml", sha, ["api"], false);
  expect(started).toEqual([
    "deploy",
    "watch",
    "--sha",
    sha,
    "--target",
    "api",
    "--config",
    "/work/widgets/armada.toml",
  ]);
  expect(t.out.join("")).toContain(`Watching the deploy of ${sha} to api`);
  t.io.startBackground = async () => false;
  const result = await startDeploys(
    t.io,
    parseConfig(configText),
    credentials,
    "/work/widgets/armada.toml",
    sha,
    ["api"],
    false,
  );
  expect(result[0]?.next).toContain("armada deploy watch");
});

test("lease cleanup failure preserves the recorded smoke result and healthy merge state", async () => {
  const t = await terminal();
  const fetch = t.io.fetch;
  t.io.fetch = async (url, init) => {
    if (String(url).endsWith("/lease/release")) return Response.json({ error: "temporary outage" }, { status: 503 });
    if (!fetch) throw new Error("missing fake API");
    return fetch(url, init);
  };
  t.io.exec = async (command, args) => ({
    code: 0,
    stdout: command === "sh" && args[1] === "version" ? sha : "ok",
    stderr: "",
  });
  expect(await run(["deploy", "watch", "--sha", sha, "--target", "api"], t.io)).toBe(0);
  expect((await t.store.deployState("widgets", { target: "api", sha }))[0]?.state).toBe("healthy");
  expect(t.err.join("")).toContain("could not release deploy smoke lease");
});
