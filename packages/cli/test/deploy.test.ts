import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, fakeArmada, fakeClock, NOW } from "../../core/test/support.ts";
import { loadCredentials } from "../src/auth.ts";
import { type Io, run } from "../src/cli.ts";
import { startDeploys } from "../src/deploy.ts";
import { createExec } from "../src/spawn.ts";

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

test("merge startup carries machine settings through the real detached Node watcher to live and smoke commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "armada-background-deploy-"));
  dirs.push(dir);
  const configPath = join(dir, "armada.toml");
  await writeFile(
    configPath,
    `${DEMO_TOML}\n[[deploy.target]]\nname = "api"\nrequires_env = ["DEPLOY_LINK_DIR"]\nlive_sha_command = 'test "$DEPLOY_LINK_DIR" = synthetic-linked-folder && printf %s "$ARMADA_DEPLOY_SHA"'\nsmoke = 'test "$DEPLOY_LINK_DIR" = synthetic-linked-folder'\ntimeout_minutes = 1\n`,
  );
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "support/deploy-background.ts")],
    outdir: dir,
    target: "node",
  });
  expect(build.success).toBe(true);
  const result = await createExec()("node", [join(dir, "deploy-background.js"), configPath], {
    cwd: dir,
    timeoutMs: 10_000,
    env: { PATH: process.env.PATH },
  });
  expect(result.code).toBe(0);
  const evidence = JSON.parse(result.stdout);
  expect(evidence.started).toBe(true);
  expect(evidence.child.code).toBe(0);
  expect(evidence.child.rows[0]?.state).toBe("healthy");
  expect(evidence.child.holds).toHaveLength(0);
});

test.each([
  ["live", 127, "sh: version-tool: command not found"],
  ["live", 2, "sh: DEPLOY_LINK_DIR: set DEPLOY_LINK_DIR"],
  ["live", 2, "sh: 1: cd: can't cd to /missing/link"],
  ["smoke", 127, "sh: health-tool: not found"],
  ["smoke", 1, "sh: DEPLOY_LINK_DIR: parameter null or not set"],
] as const)(
  "%s configuration error (%i, %s) warns once and sends a deploy notice without a hold",
  async (stage, code, message) => {
    const t = await terminal();
    t.io.env.LINEAR_API_KEY = "synthetic-linear-key";
    let failures = 0;
    t.io.exec = async (_command, args) => {
      const failing = stage === "live" ? args[1] === "version" : args[1] === "health";
      if (failing) {
        failures++;
        return { code, stdout: "", stderr: message };
      }
      return { code: 0, stdout: sha, stderr: "" };
    };
    expect(await run(["deploy", "watch", "--sha", sha, "--target", "api"], t.io)).toBe(0);
    expect(failures).toBe(1);
    expect(t.err).toHaveLength(1);
    expect(t.err[0]).toContain("deploy check not runnable on this machine");
    expect(t.err[0]).toContain(message);
    expect((await t.store.deployState("widgets", { target: "api", sha }))[0]?.state).toBe("not-runnable");
    const items = await t.store.openInboxItems({ project: "widgets", recipient: "coordinator" });
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("deploy");
    expect(items[0]?.body).toContain(message);
    expect(await t.store.openHolds("widgets")).toHaveLength(0);
  },
);

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

test("a runnable live-commit command failure still waits to its deadline and holds", async () => {
  const t = await terminal();
  t.io.env.LINEAR_API_KEY = "synthetic-linear-key";
  let commands = 0;
  t.io.exec = async () => {
    commands++;
    return { code: 1, stdout: "", stderr: "hosting service unavailable" };
  };
  expect(await run(["deploy", "watch", "--sha", sha, "--target", "api"], t.io)).toBe(1);
  expect(commands).toBe(2);
  expect((await t.store.deployState("widgets", { target: "api", sha }))[0]?.state).toBe("timeout");
  expect(await t.store.openHolds("widgets")).toHaveLength(1);
  const items = await t.store.openInboxItems({ project: "widgets", recipient: "coordinator" });
  expect(items).toHaveLength(1);
  expect(items[0]?.body).toContain("hosting service unavailable");
  expect(t.err.join("")).not.toContain("not runnable");
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
  t.out.splice(0);
  await startDeploys(
    t.io,
    parseConfig(configText.replace('smoke = "health"', "")),
    credentials,
    "/work/widgets/armada.toml",
    sha,
    ["api"],
    false,
  );
  expect(t.out.join("")).toBe(
    `Watching the deploy of ${sha} to api (no smoke command: a live but broken service reads healthy)\n`,
  );
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

test("failed smoke diagnostics mask credentials and declared project secrets before persistence", async () => {
  const t = await terminal();
  t.io.env.SERVICE_PASSWORD = "synthetic-private-password";
  t.io.readFile = async (path) =>
    path === "/work/widgets/armada.toml" ? `${configText}\n[secrets]\nnames = ["SERVICE_PASSWORD"]` : null;
  t.io.exec = async (_command, args) =>
    args[1] === "version"
      ? { code: 0, stdout: sha, stderr: "" }
      : { code: 1, stdout: "health failed", stderr: `${t.io.env.ARMADA_API_KEY}\n${t.io.env.SERVICE_PASSWORD}` };
  expect(await run(["deploy", "watch", "--sha", sha, "--target", "api"], t.io)).toBe(1);
  const stored = JSON.stringify({
    rows: await t.store.deployState("widgets", {}),
    inbox: await t.store.openInboxItems({ project: "widgets", recipient: "coordinator" }),
    holds: await t.store.openHolds("widgets"),
    output: t.out.join("") + t.err.join(""),
  });
  expect(stored.includes(t.io.env.ARMADA_API_KEY ?? "")).toBe(false);
  expect(stored.includes(t.io.env.SERVICE_PASSWORD)).toBe(false);
  expect(stored).toContain("[redacted]");
  expect(stored).toContain("health failed");
});

test("machine deploy requirements skip without a hold, then configured commands run with local precedence and env fallback", async () => {
  const t = await terminal();
  const required = `${configText}requires_env = ["DEPLOY_LINK_DIR", "DEPLOY_REGION", "toString"]\n`;
  t.io.readFile = async (path) => (path === "/work/widgets/armada.toml" ? required : null);
  const config = parseConfig(required);
  const credentials = (await loadCredentials(t.io, { armada: false })).credentials;
  let starts = 0;
  t.io.startBackground = async () => {
    starts++;
    return true;
  };
  t.io.exec = async () => {
    throw new Error("unconfigured targets must not execute commands");
  };
  await startDeploys(t.io, config, credentials, "/work/widgets/armada.toml", sha, ["api"], false);
  expect(starts).toBe(0);
  expect(t.err.join("")).toContain(
    "deploy check skipped: DEPLOY_LINK_DIR, DEPLOY_REGION, toString not set on this machine",
  );
  expect(t.err).toHaveLength(1);
  expect((await t.store.deployState("widgets", { target: "api", sha }))[0]).toMatchObject({
    state: "skipped",
    detail: "skipped (not configured on this machine): DEPLOY_LINK_DIR, DEPLOY_REGION, toString",
  });
  expect(await t.store.openHolds("widgets")).toHaveLength(0);
  expect(await t.store.openInboxItems({ project: "widgets", recipient: "coordinator" })).toHaveLength(0);
  expect(await run(["deploy", "watch", "--sha", sha, "--target", "api"], t.io)).toBe(0);
  expect(await run(["config", "set", "deploy.env.DEPLOY_LINK_DIR", "/local/linked folder"], t.io)).toBe(0);
  // Settings are scoped to the selected project, not the checkout or another project.
  t.io.readFile = async (path) =>
    path === "/work/widgets/armada.toml" ? required.replace('slug = "widgets"', 'slug = "other--"') : null;
  expect(await run(["deploy", "watch", "--sha", sha, "--target", "api"], t.io)).toBe(0);
  expect((await t.store.deployState("other--", { target: "api", sha }))[0]?.state).toBe("skipped");
  expect(await run(["config", "set", "deploy.env.DEPLOY_LINK_DIR", "/other/project"], t.io)).toBe(0);
  t.io.readFile = async (path) => (path === "/work/widgets/armada.toml" ? required : null);
  t.io.env.DEPLOY_LINK_DIR = "/environment/fallback";
  t.io.env.DEPLOY_REGION = "test-region";
  Object.assign(t.io.env, { toString: "valid-shell-variable" });
  let commands = 0;
  t.io.exec = async (_command, args, options) => {
    commands++;
    expect(options.env?.DEPLOY_LINK_DIR).toBe("/local/linked folder");
    expect(options.env?.DEPLOY_REGION).toBe("test-region");
    expect(Object.entries(options.env ?? {}).find(([name]) => name === "toString")?.[1]).toBe("valid-shell-variable");
    return { code: 0, stdout: args[1] === "version" ? sha : "ok", stderr: "" };
  };
  expect(await run(["deploy", "watch", "--sha", sha, "--target", "api"], t.io)).toBe(0);
  expect(commands).toBe(2);
  expect((await t.store.deployState("widgets", { target: "api", sha }))[0]?.state).toBe("healthy");
  expect(await t.store.openHolds("widgets")).toHaveLength(0);
  expect(t.out.join("") + t.err.join("")).not.toContain("/local/linked folder");
  expect(await run(["config", "unset", "deploy.env.DEPLOY_LINK_DIR"], t.io)).toBe(0);
  t.io.exec = async (_command, args, options) => {
    expect(options.env?.DEPLOY_LINK_DIR).toBe("/environment/fallback");
    return { code: args[1] === "version" ? 0 : 1, stdout: args[1] === "version" ? live : "failed", stderr: "" };
  };
  expect(await run(["deploy", "watch", "--sha", live, "--target", "api"], t.io)).toBe(1);
  expect(await t.store.openHolds("widgets")).toHaveLength(1);
  // A damaged settings file cannot throw from the post-merge startup callback.
  await writeFile(join(t.io.env.XDG_CONFIG_HOME as string, "armada", "projects", "widgets.json"), "{broken");
  const nextSha = "d".repeat(40);
  await startDeploys(t.io, config, credentials, "/work/widgets/armada.toml", nextSha, ["api"], false);
  expect(starts).toBe(1);
  expect(t.err.join("")).toContain("invalid project machine settings");
});

test.each([0, 1, 2])(
  "check exit %i is wired through bounded commands, durable state and the watcher exit",
  async (code) => {
    const t = await terminal();
    const checked = configText.replace('live_sha_command = "version"', 'check = "host-check"');
    t.io.readFile = async (path) => (path === "/work/widgets/armada.toml" ? checked : null);
    let commands = 0;
    let smokes = 0;
    t.io.exec = async (command, args, options) => {
      expect(command).toBe("sh");
      expect(options.cwd).toBe("/work/widgets");
      expect(options.timeoutMs).toBe(60_000);
      expect(options.env?.ARMADA_DEPLOY_SHA).toBe(sha);
      expect(options.env?.ARMADA_DEPLOY_TARGET).toBe("api");
      if (args[1] === "health") {
        smokes++;
        return { code: 0, stdout: "health ok", stderr: "" };
      }
      expect(args[1]).toBe("host-check");
      commands++;
      return {
        code,
        stdout: code === 2 ? "skipped: no files of this service changed" : "host build output",
        stderr: "",
      };
    };
    expect(await run(["deploy", "watch", "--sha", sha, "--target", "api"], t.io)).toBe(code === 1 ? 1 : 0);
    expect(commands).toBe(1);
    expect(smokes).toBe(code === 0 ? 1 : 0);
    const state = code === 0 ? "healthy" : code === 1 ? "deploy-failed" : "not-deployed";
    expect((await t.store.deployState("widgets", { target: "api", sha }))[0]?.state).toBe(state);
    expect(await run(["deploy", "status"], t.io)).toBe(0);
    const holds = await t.store.openHolds("widgets");
    expect(holds).toHaveLength(code === 1 ? 1 : 0);
    expect(await t.store.openInboxItems({ project: "widgets", recipient: "coordinator" })).toHaveLength(
      code === 1 ? 1 : 0,
    );
    if (code === 1) expect(holds[0]?.reason).toContain("host build output");
    if (code === 2) {
      expect(t.out.join("")).toContain("api: not deployed (host skipped: no files of this service changed)");
      t.io.exec = async () => ({ code: 0, stdout: "live now", stderr: "" });
      expect(await run(["deploy", "watch", "--sha", sha, "--target", "api"], t.io)).toBe(0);
      expect((await t.store.deployState("widgets", { target: "api", sha }))[0]?.state).toBe("healthy");
    }
  },
);

test("a check killed by the output bound stays pending instead of trusting its synthetic exit 1", async () => {
  const t = await terminal();
  t.io.readFile = async (path) =>
    path === "/work/widgets/armada.toml"
      ? configText.replace('live_sha_command = "version"', 'check = "host-check"')
      : null;
  t.io.exec = async () => ({ code: 1, stdout: "", stderr: "", outputExceeded: true });
  t.io.env.LINEAR_API_KEY = "synthetic-linear-key";
  let polls = 0;
  t.io.sleep = async (ms) => {
    if (ms !== 30_000) {
      await t.clock.sleep(ms);
      return;
    }
    if (++polls === 1) {
      expect((await t.store.deployState("widgets", { target: "api", sha }))[0]?.state).toBe("waiting");
      expect(await t.store.openHolds("widgets")).toHaveLength(0);
      expect(await t.store.openInboxItems({ project: "widgets", recipient: "coordinator" })).toHaveLength(0);
    }
    await t.clock.sleep(ms);
  };
  expect(await run(["deploy", "watch", "--sha", sha, "--target", "api"], t.io)).toBe(1);
  expect(polls).toBe(2);
  expect((await t.store.deployState("widgets", { target: "api", sha }))[0]).toMatchObject({
    state: "timeout",
    detail: "deploy deadline reached\ncheck output exceeded limit",
  });
});
