import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARMADA_URL, DEMO_TOML, fakeArmada, NOW } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { ExecResult, Io } from "../src/io.ts";

const KEY = "armada_key_CANARY_job";
const LEAK = "secret-CANARY-command-output";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(
  worker = false,
  extraConfig = '\nstatus = "status-runner"',
  result: ExecResult = { code: 0, stdout: "tool chatter\nrunner-1\n", stderr: LEAK },
) {
  const home = await mkdtemp(join(tmpdir(), "armada-job-"));
  dirs.push(home);
  const root = join(home, "repo");
  const api = fakeArmada({ keys: { [KEY]: "coordinator" } });
  const out: string[] = [],
    err: string[] = [];
  const execs: { command: string; args: string[]; options: unknown }[] = [];
  const io: Io = {
    cwd: join(root, "packages/app"),
    env: {
      XDG_CONFIG_HOME: join(home, "config"),
      ARMADA_API_URL: ARMADA_URL,
      ...(worker ? {} : { ARMADA_API_KEY: KEY }),
    },
    readFile: async (path) =>
      path === join(root, "armada.toml")
        ? `${DEMO_TOML}\n[jobs.eval]\nstart = "start-runner"\nstop = "stop-runner"\nmax_hours = 1${extraConfig}`
        : null,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ghToken: () => null,
    fetch: api.fetch,
    now: () => NOW,
    gitBranch: () => "feature/demo-7-job",
    exec: async (command, args, options) => {
      execs.push({ command, args, options });
      return result;
    },
  };
  if (worker) {
    const launch = "armada_launch_CANARY_job";
    api.launches.set(launch, { ticket: "DEMO-7", project: "widgets", used: false });
    expect(await run(["login", "--launch-token", launch], io)).toBe(0);
    out.splice(0);
    err.splice(0);
  }
  return {
    io,
    api,
    execs,
    root,
    printed: () => {
      const r = { out: out.splice(0).join(""), err: err.splice(0).join("") };
      expect(r.out + r.err).not.toContain(KEY);
      expect(r.out + r.err).not.toContain(LEAK);
      return r;
    },
  };
}

describe("armada job", () => {
  test("dispatches with a durable id at the repository root, then a fresh terminal polls progress and stops", async () => {
    const s = await setup();
    expect(await run(["job", "start", "eval", "--ticket", "DEMO-7", "--json"], s.io)).toBe(0);
    const [job] = JSON.parse(s.printed().out);
    expect(job).toMatchObject({ id: 1, state: "running", ref: "runner-1", ticket: "DEMO-7" });
    expect(s.execs[0]).toMatchObject({
      command: "sh",
      args: ["-c", "start-runner"],
      options: {
        cwd: s.root,
        timeoutMs: 120_000,
        processGroup: true,
        env: { ARMADA_JOB_ID: "1", ARMADA_JOB_REF: "", ARMADA_TICKET: "DEMO-7", ARMADA_PROJECT: "widgets" },
      },
    });
    const fresh = {
      ...s.io,
      cwd: join(s.root, "another-folder"),
      now: () => new Date(NOW.getTime() + 2 * 3_600_000),
      exec: async () => ({ code: 0, stdout: "running 37/120 cases", stderr: LEAK }),
    };
    expect(await run(["job", "status"], fresh)).toBe(0);
    const status = s.printed();
    expect(status.out).toContain("runner-1");
    expect(status.out).toContain("37/120 cases");
    expect(status.out).toContain("ETA");
    expect(status.out).toContain("overdue");
    expect(await run(["job", "list", "--json"], fresh)).toBe(0);
    expect(JSON.parse(s.printed().out)[0].progress).toBe("37/120 cases");
    expect(await run(["job", "stop", "1"], s.io)).toBe(0);
    expect(s.execs.at(-1)).toMatchObject({
      args: ["-c", "stop-runner"],
      options: { env: { ARMADA_JOB_REF: "runner-1" } },
    });
    expect(s.printed().out).toContain("stopped");
    expect(await run(["job", "status"], fresh)).toBe(0);
    expect(s.printed().out).toBe("No jobs.\n");
  });

  test("a worker defaults to its own ticket and reads only its jobs without requesting keys", async () => {
    const s = await setup(true);
    await s.api.store.startJob({ project: "widgets", ticket: "DEMO-8", name: "eval", startedBy: "other", at: NOW });
    expect(await run(["job", "start", "eval"], s.io)).toBe(0);
    expect(s.printed().out).toContain("DEMO-7");
    expect(await run(["job", "list", "--json"], { ...s.io, gitBranch: () => null })).toBe(0);
    expect(JSON.parse(s.printed().out).map((j: { ticket: string }) => j.ticket)).toEqual(["DEMO-7"]);
    const count = s.execs.length;
    expect(await run(["job", "stop", "1"], s.io)).toBe(2);
    expect(s.execs).toHaveLength(count);
    expect(s.printed().err).toContain("not on this ticket");
    expect(await run(["job", "recover", "1", "--ref", "foreign"], s.io)).toBe(2);
    expect(s.printed().err).toContain("not on this ticket");
    expect(s.execs).toHaveLength(count);
    expect(s.api.calls.some((c) => c.method === "POST" && c.path === "credentials")).toBe(false);
    s.api.end("DEMO-7", "this worker was cut off from Armada");
    expect(await run(["job", "start", "eval"], s.io)).toBe(1);
    expect(s.execs).toHaveLength(count);
    expect(s.printed().err).toContain("cut off");
  });

  test("an empty start reference remains recorded, visible, and refuses status/stop before executing", async () => {
    const s = await setup(false, undefined, { code: 0, stdout: "\n", stderr: LEAK });
    expect(await run(["job", "start", "eval"], s.io)).toBe(0);
    expect(s.printed().out).toContain("no runner reference");
    for (const command of [
      ["job", "status"],
      ["job", "stop", "1"],
    ]) {
      expect(await run(command, s.io)).toBe(1);
      expect(s.printed().err).toContain("no runner reference");
    }
    expect(s.execs).toHaveLength(1);
    expect(await run(["job", "recover", "1", "--ref", "found-run"], s.io)).toBe(0);
    expect(s.printed().out).toContain("found-run");
    expect(s.execs).toHaveLength(1);
  });

  test("missing status commands and list read the durable state without shell execution", async () => {
    const s = await setup(false, "");
    expect(await run(["job", "start", "eval"], s.io)).toBe(0);
    s.printed();
    expect(await run(["job", "status"], s.io)).toBe(0);
    expect(s.printed().out).toContain("running");
    expect(await run(["job", "list"], s.io)).toBe(0);
    s.printed();
    expect(s.execs).toHaveLength(1);
  });

  test("failed or uncertain starts are recorded once; command output is never exposed", async () => {
    for (const result of [
      { code: 3, stdout: LEAK, stderr: LEAK },
      { code: 1, stdout: LEAK, stderr: LEAK, timedOut: true },
    ]) {
      const s = await setup(false, undefined, result);
      expect(await run(["job", "start", "eval"], s.io)).toBe(1);
      const record = (await s.api.store.listJobs("widgets", {}))[0];
      expect(record?.state).toBe(result.timedOut ? "lost" : "failed");
      expect(s.execs).toHaveLength(1);
      s.printed();
    }
  });

  test("a failed status preserves the latest observation; an unavailable recording never repeats dispatch", async () => {
    const s = await setup();
    expect(await run(["job", "start", "eval"], s.io)).toBe(0);
    s.printed();
    s.io.exec = async () => ({ code: 0, stdout: "unknown words", stderr: LEAK });
    expect(await run(["job", "status"], s.io)).toBe(1);
    expect((await s.api.store.getJob("widgets", 1))?.state).toBe("running");
    s.printed();
    const baseFetch = s.api.fetch;
    s.io.fetch = async (url, init) =>
      url.endsWith("fleet/job/observe") ? Response.json({ error: "outage" }, { status: 503 }) : baseFetch(url, init);
    s.io.exec = async () => ({ code: 0, stdout: "runner-2", stderr: LEAK });
    expect(await run(["job", "start", "eval"], s.io)).toBe(1);
    const printed = s.printed();
    expect(printed.err).toContain("job 2");
    expect(printed.err).toContain("runner-2");
    expect(printed.err).toContain("Do not retry");
    expect((await s.api.store.getJob("widgets", 2))?.state).toBe("starting");
    expect(printed.err).toContain("armada job recover 2 --state running --ref 'runner-2'");
    let nativeWrites = 0;
    s.io.exec = async () => {
      nativeWrites++;
      return { code: 0, stdout: "running 2/4", stderr: LEAK };
    };
    s.io.fetch = baseFetch;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await run(["job", "recover", "2", "--ref", "runner-2"], s.io)).toBe(0);
      expect(s.printed().out).toContain("runner-2");
    }
    expect(nativeWrites).toBe(0);
    expect(await run(["job", "recover", "2", "--ref", "different-run"], s.io)).toBe(2);
    expect(s.printed().err).toContain("cannot change");
    expect(await run(["job", "status", "2"], s.io)).toBe(0);
    s.printed();
    expect(await run(["job", "stop", "2"], s.io)).toBe(0);
    s.printed();
    expect(nativeWrites).toBe(2);
    expect(await run(["job", "recover", "2", "--state", "running"], s.io)).toBe(2);
    expect(s.printed().err).toContain("outcome cannot change");
    expect(nativeWrites).toBe(2);
  });
  test("recovery finalizes failed or uncertain dispatch reservations after recording outages without shell execution", async () => {
    for (const result of [
      { code: 3, stdout: LEAK, stderr: LEAK },
      { code: 1, stdout: LEAK, stderr: LEAK, timedOut: true },
    ]) {
      const s = await setup(false, undefined, result);
      const baseFetch = s.api.fetch;
      s.io.fetch = async (url, init) =>
        url.endsWith("fleet/job/observe") ? Response.json({ error: "outage" }, { status: 503 }) : baseFetch(url, init);
      expect(await run(["job", "start", "eval"], s.io)).toBe(1);
      s.printed();
      const state = result.timedOut ? "lost" : "failed";
      s.io.fetch = baseFetch;
      expect(await run(["job", "recover", "1", "--state", state], s.io)).toBe(0);
      expect(s.printed().out).toContain(state);
      expect(s.execs).toHaveLength(1);
    }
  });
});
