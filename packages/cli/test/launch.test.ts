import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, FakeLinear, fakeArmada, NOW } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";

// Canary secrets: no output may ever contain them.
const LINEAR = "lin_api_CANARY_launcher_key";
const LAUNCH = "armada_launch_CANARY_1";
const WORKER = "armada_worker_CANARY_1";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * A worker's runtime: nothing in its environment but a config home, a fake
 * Armada that keeps the organization's keys and has launched DEMO-7, and a
 * fake Linear that records which key wrote to it.
 */
async function runtime(env: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "armada-launch-"));
  dirs.push(home);
  const store = memoryFleet();
  const armada = fakeArmada({
    store,
    vault: { linear: { apiKey: LINEAR, scope: "own" }, now: () => NOW },
  });
  armada.launches.set(LAUNCH, { project: "widgets", ticket: "DEMO-7", used: false });
  const linear = new FakeLinear();
  linear.add("DEMO-7");
  linear.add("DEMO-8");
  const keys: string[] = [];
  const out: string[] = [];
  const io: Io = {
    cwd: "/work/widgets",
    env: { XDG_CONFIG_HOME: home, ...env },
    readFile: async (path) => (path === "/work/widgets/armada.toml" ? DEMO_TOML : null),
    stdout: (t) => out.push(t),
    stderr: (t) => out.push(t),
    ghToken: () => null,
    fetch: armada.fetch,
    now: () => NOW,
    gitBranch: () => "feature/demo-7-do-the-thing",
    linearWriter: (o) => {
      keys.push(o.apiKey);
      return linear;
    },
  };
  return {
    io,
    armada,
    store,
    linear,
    keys,
    credentials: join(home, "armada", "credentials"),
    /** Everything printed since the last call; asserts no secret leaked. */
    printed: () => {
      const text = out.splice(0).join("");
      for (const secret of [LINEAR, LAUNCH, WORKER]) expect(text).not.toContain(secret);
      return text;
    },
  };
}

describe("a worker signed in with its launch token", () => {
  test("with only the launch message, it signs in, claims, reports and hands the ticket back", async () => {
    const r = await runtime();
    expect(await run(["login", "--launch-token", LAUNCH, "--api-url", ARMADA_URL], r.io)).toBe(0);
    expect(r.printed()).toBe(
      "Signed in to armada.example.test as the worker of DEMO-7 (widgets) in Acme, launched by Ada Example.\nThis terminal claims, reports, asks and releases DEMO-7 only; Armada gives each of those commands its keys.\n",
    );
    const file = await readFile(r.credentials, "utf8");
    expect(file).toMatch(/^ARMADA_WORKER_SESSION_DEMO_7=\S+\n$/);
    expect(file).not.toContain(LAUNCH);
    expect((await stat(r.credentials)).mode & 0o777).toBe(0o600);
    expect(await run(["whoami"], r.io)).toBe(0);
    expect(r.printed()).toBe(
      "Signed in to armada.example.test as the worker of DEMO-7 (widgets), launched by Ada Example, in Acme.\n",
    );

    expect(await run(["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws/s"], r.io)).toBe(0);
    expect(r.printed()).toContain("Claimed DEMO-7 for Conductor (ws/s).");
    expect(await run(["report", "implementing", "--message", "plan"], r.io)).toBe(0);
    expect(r.printed()).toContain("DEMO-7: planning → implementing.");
    // The Linear key came from Armada, asked with the worker session for this command and ticket.
    expect(r.keys).toEqual([LINEAR, LINEAR]);
    const asked = r.armada.calls.filter((c) => c.path === "credentials");
    expect(asked.map((c) => [c.authorization, (c.body as { purpose: unknown }).purpose])).toEqual([
      [`Bearer ${WORKER}`, { command: "claim", project: "widgets", ticket: "DEMO-7" }],
      [`Bearer ${WORKER}`, { command: "report", project: "widgets", ticket: "DEMO-7" }],
    ]);

    expect(await run(["release", "--reason", "handing back"], r.io)).toBe(0);
    expect(r.printed()).toContain("Signed out of Armada: the worker session of DEMO-7 has ended.\n");
    // No database variable anywhere: the worker session recorded every step on Armada.
    expect(r.store.events.map((e) => [e.ticket, e.kind])).toEqual([
      ["DEMO-7", "claim"],
      ["DEMO-7", "report"],
      ["DEMO-7", "release"],
    ]);
    expect((await r.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(NOW.toISOString());
    expect(r.armada.workers.get(WORKER)?.ended).toBe("the ticket was released");
    expect(await readFile(r.credentials, "utf8")).toBe("");
  });

  test("the masked token of the brief's human view is named at once, without asking Armada", async () => {
    const r = await runtime();
    expect(await run(["login", "--launch-token", "armada_launch_••••", "--api-url", ARMADA_URL], r.io)).toBe(1);
    expect(r.printed()).toBe(
      "armada: this is the masked token from `armada brief`'s human view, not a launch token\nNext: ask the coordinator for the `armada brief <ticket> --prompt` text: only it carries the token\n",
    );
    expect(r.armada.calls).toEqual([]);
  });

  test("the token signs in once, naming its Conductor session; another ticket gets no key from the session", async () => {
    const r = await runtime({ CONDUCTOR_WORKSPACE_ID: "ws-7", CONDUCTOR_SESSION_ID: "s-7" });
    expect(await run(["login", "--launch-token", LAUNCH, "--api-url", ARMADA_URL], r.io)).toBe(0);
    r.printed();
    // Armada shows the session if the worker never claims.
    expect(r.armada.calls.find((c) => c.path === "launch-tokens/exchange")?.body).toEqual({
      token: LAUNCH,
      handle: "ws-7/s-7",
    });
    expect(await run(["login", "--launch-token", LAUNCH, "--api-url", ARMADA_URL], r.io)).toBe(1);
    expect(r.printed()).toBe("armada: this launch token was already used\nNext: a new launch\n");

    expect(await run(["report", "implementing", "--ticket", "DEMO-8", "--message", "x"], r.io)).toBe(2);
    expect(r.printed()).toContain("LINEAR_API_KEY is not set");
    expect(r.keys).toEqual([]);
    expect(r.armada.calls.filter((c) => c.path === "credentials")).toEqual([]);
  });

  test("revoked, its next report fails with Armada's reason, even with keys in its environment", async () => {
    const r = await runtime({ LINEAR_API_KEY: "lin_api_CANARY_env_key" });
    expect(await run(["login", "--launch-token", LAUNCH, "--api-url", ARMADA_URL], r.io)).toBe(0);
    expect(await run(["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws/s"], r.io)).toBe(0);
    r.printed();
    r.armada.end(
      "DEMO-7",
      "this worker was cut off from Armada by Olive Owner at 2026-03-04 10:30 UTC: stop working on DEMO-7",
    );
    expect(await run(["report", "implementing", "--message", "plan"], r.io)).toBe(1);
    expect(r.printed()).toBe(
      "armada: this worker was cut off from Armada by Olive Owner at 2026-03-04 10:30 UTC: stop working on DEMO-7\nNext: report it to the coordinator\n",
    );
    expect(r.linear.bodies.filter((b) => b.startsWith("Agent status: implementing"))).toEqual([]);
  });

  test("login refuses --api-url without a token, and a token with --api-key", async () => {
    const r = await runtime();
    expect(await run(["login", "--api-url", ARMADA_URL], r.io)).toBe(2);
    expect(r.printed()).toContain("--api-url goes with --launch-token");
    expect(await run(["login", "--api-key", "--launch-token", LAUNCH], r.io)).toBe(2);
    expect(r.printed()).toContain("pass --api-key or --launch-token, not both");
  });
});

describe("the coordinator's merge and release end the ticket's worker sessions", () => {
  test("a signed-in coordinator releasing a ticket ends its worker session on Armada", async () => {
    const r = await runtime();
    expect(await run(["login", "--launch-token", LAUNCH, "--api-url", ARMADA_URL], r.io)).toBe(0);
    expect(await run(["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws/s"], r.io)).toBe(0);
    // The coordinator's own terminal: signed in as a person, on another machine.
    const home = await mkdtemp(join(tmpdir(), "armada-coordinator-"));
    dirs.push(home);
    r.armada.sessions.add("CANARY_coordinator");
    await mkdir(join(home, "armada"));
    await writeFile(
      join(home, "armada", "credentials"),
      `ARMADA_SESSION_TOKEN=CANARY_coordinator\nARMADA_SIGNED_IN_TO=${ARMADA_URL}\n`,
    );
    const coordinator: Io = {
      ...r.io,
      env: { XDG_CONFIG_HOME: home, ARMADA_API_URL: ARMADA_URL, LINEAR_API_KEY: "k" },
    };
    r.printed();
    expect(await run(["release", "--ticket", "DEMO-7", "--reason", "stuck"], coordinator)).toBe(0);
    expect(r.printed()).toContain("Ended the worker session of DEMO-7 on Armada.\n");
    expect(r.armada.calls.at(-1)).toMatchObject({
      path: "workers/end",
      authorization: "Bearer CANARY_coordinator",
      body: { project: "widgets", ticket: "DEMO-7", reason: "released" },
    });
    expect(r.armada.workers.get(WORKER)?.ended).toBe("the ticket was released");
  });
});
