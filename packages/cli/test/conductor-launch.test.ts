import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArmadaApiError, parseConfig, resolveCredentials } from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, FakeLinear, fakeArmada, NOW, recordedFetch } from "../../core/test/support.ts";
import { version } from "../package.json" with { type: "json" };
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";
import { type BindLaunch, launchWorker } from "../src/launch.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});
const TOML = `${DEMO_TOML}
[conductor]
default_profile = "backend"
[conductor.profiles.backend]
agent = "codex"
model = "synthetic-model"
effort = "high"
fast_mode = true
`;
const CANARY = "armada_launch_CANARY_1";
const json = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
async function fixture(toml = TOML) {
  const home = await mkdtemp(join(tmpdir(), "armada-conductor-launch-"));
  homes.push(home);
  const linear = new FakeLinear();
  linear.add("DEMO-13");
  const store = memoryFleet();
  const armada = fakeArmada({
    store,
    keys: { armada_key_CANARY_test: "test" },
    vault: { linear: { apiKey: "lin_api_CANARY", scope: "own" }, now: () => NOW },
  });
  const ticket = {
    identifier: "DEMO-13",
    title: "Synthetic worker",
    url: "https://linear.app/acme/issue/DEMO-13",
    branchName: "feature/demo-13",
    description: "## In short\nBuild a widget.",
    state: { name: "Todo", type: "unstarted" },
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    parent: { identifier: "DEMO-2", title: "Widget spec", url: "https://linear.app/acme/issue/DEMO-2" },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [] as unknown[], pageInfo: { hasNextPage: false } },
  };
  const recorded = recordedFetch({ linear: (r) => Object.assign(r, { Brief: [{ data: { issue: ticket } }] }) });
  const calls: { command: string; args: string[]; input?: string; timeoutMs?: number }[] = [];
  const stdout: string[] = [],
    stderr: string[] = [],
    reads: string[] = [],
    revoked: string[] = [];
  const files = new Map([
    ["/work/widgets/armada.toml", toml],
    ["/work/widgets/nested/notes.md", "Use the existing widget.\n"],
  ]);
  let fail = 0,
    timedOut = false,
    auth = true;
  let matches = 1;
  let renamed = false;
  let workspaceMore = false;
  let sessionMore = false;
  let recoveryFailure: "unavailable" | "malformed" | null = null;
  let bindingError: Error | null = null;
  const bindings: unknown[] = [];
  const io: Io = {
    linearWriter: () => linear,
    cwd: "/work/widgets/nested",
    env: {
      XDG_CONFIG_HOME: home,
      ARMADA_API_URL: ARMADA_URL,
      ARMADA_API_KEY: "armada_key_CANARY_test",
      LINEAR_API_KEY: "lin_api_CANARY",
    },
    readFile: async (p) => {
      reads.push(p);
      return files.get(p) ?? null;
    },
    readStdin: async () => "Notes from stdin.",
    stdout: (t) => stdout.push(t),
    stderr: (t) => stderr.push(t),
    ghToken: () => null,
    now: () => NOW,
    fetch: async (url, init) => {
      if (url.endsWith("/launch-tokens/bind")) {
        const body = JSON.parse(String(init.body));
        bindings.push(body);
        const row = [...armada.launches.values()].find((l) => l.ticket === body.ticket);
        if (row) Object.assign(row, { runtime: body.runtime, runtimeHandle: body.handle });
        return Response.json({ id: body.id, ticket: body.ticket });
      }
      if (url.endsWith("/workers/revoke-pending")) {
        const body = JSON.parse(String(init.body));
        revoked.push(body.id);
        return Response.json({ id: body.id, ticket: body.ticket });
      }
      return url.startsWith(ARMADA_URL) ? armada.fetch(url, init) : recorded.fetch(url, init);
    },
    exec: async (command, args, options) => {
      calls.push({ command, args, input: options.input, timeoutMs: options.timeoutMs });
      if (command === "git")
        return {
          code: 0,
          stdout: args[0] === "rev-parse" ? "/work/widgets\n" : "ref: refs/heads/trunk\tHEAD\n",
          stderr: "",
        };
      const a = args.slice(1);
      if (a[0] === "--version") return { code: 0, stdout: "0.90.1", stderr: "" };
      if (a[0] === "auth") return { code: auth ? 0 : 3, stdout: "", stderr: CANARY };
      if (a[0] === "model")
        return json({
          agents: [
            { agent: "codex", models: ["synthetic-model"], efforts: ["high"], fastModeModels: ["synthetic-model"] },
          ],
        });
      if (a[1] === "create")
        return timedOut
          ? { code: 1, stdout: CANARY, stderr: CANARY, timedOut: true }
          : fail
            ? { code: fail, stdout: CANARY, stderr: CANARY }
            : json({
                workspaceId: "ws-1",
                sessionId: "ses-1",
                deepLink: "conductor://workspace?id=ws-1&session=ses-1",
                initialMessage: { messageId: "msg-1", state: "queued" },
              });
      if (a[1] === "list" && recoveryFailure)
        return recoveryFailure === "unavailable"
          ? { code: 4, stdout: CANARY, stderr: CANARY }
          : json({ data: "invalid", hasMore: false });
      if (a[1] === "list")
        return json({
          data: Array.from({ length: matches }, (_, i) => ({
            id: `ws-${i + 1}`,
            name: renamed ? "Updated workspace title" : "DEMO-13 Synthetic worker",
            repoUrl: "https://github.com/acme/widgets",
            createdAt: NOW.toISOString(),
            state: "ready",
            deepLink: `conductor://workspace?id=ws-${i + 1}`,
          })),
          hasMore: workspaceMore,
        });
      if (a[0] === "workspace" && a[1] === "session")
        return json({
          data: [
            {
              id: `ses-${a[2]?.split("-")[1]}`,
              name: renamed ? "Updated session title" : "DEMO-13",
              deepLink: `conductor://workspace?id=${a[2]}&session=ses-1`,
            },
          ],
          hasMore: sessionMore,
        });
      if (a[0] === "session" && a[1] === "status")
        return json({ workspaceId: `ws-${a[2]?.split("-")[1]}`, sessionId: a[2], status: "working" });
      throw new Error("unexpected exec");
    },
  };
  const bind: BindLaunch = async (_signIn, target) => {
    if (bindingError) throw bindingError;
    bindings.push(target);
  };
  return {
    io,
    linear,
    armada,
    store,
    ticket,
    files,
    reads,
    calls,
    revoked,
    bindings,
    set: (o: {
      fail?: number;
      timedOut?: boolean;
      matches?: number;
      auth?: boolean;
      bindingError?: Error;
      renamed?: boolean;
      workspaceMore?: boolean;
      sessionMore?: boolean;
      recoveryFailure?: "unavailable" | "malformed";
    }) => {
      recoveryFailure = o.recoveryFailure ?? recoveryFailure;
      renamed = o.renamed ?? renamed;
      workspaceMore = o.workspaceMore ?? workspaceMore;
      sessionMore = o.sessionMore ?? sessionMore;
      fail = o.fail ?? fail;
      timedOut = o.timedOut ?? timedOut;
      matches = o.matches ?? matches;
      auth = o.auth ?? auth;
      bindingError = o.bindingError ?? bindingError;
    },
    launch: (options: Record<string, string> = {}) =>
      launchWorker(
        io,
        parseConfig(toml),
        resolveCredentials({ env: io.env }),
        { rest: ["DEMO-13"], json: true, options },
        version,
        "/work/widgets/armada.toml",
        bind,
      ),
    output: () => {
      const text = stdout.join("") + stderr.join("");
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain("lin_api_CANARY");
      return text;
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

test("Conductor launch briefs include shared keys and holders from the same brief input as herdr", async () => {
  const f = await fixture(
    `${TOML}\n[[reservations]]\nkey = "db-migration"\nwhat = "the next schema version"\nnumbered = true\n`,
  );
  await f.store.reserve({
    project: "widgets",
    key: "db-migration",
    value: "27",
    next: false,
    floor: 0,
    ticket: "DEMO-12",
    note: null,
    at: NOW,
  });
  expect(await f.launch()).toBe(0);
  const prompt = f.calls.find((c) => c.args[2] === "create")?.input;
  expect(prompt).toContain("db-migration: the next schema version");
  expect(prompt).toContain("db-migration = 27: DEMO-12");
});

test("native launch routes the profile, sends the token and coordinator notes only on stdin, binds and prints ids", async () => {
  const f = await fixture();
  f.io.env.ARMADA_COORDINATOR = "front";
  expect(await run(["launch", "DEMO-13", "--runtime", "conductor", "--notes", "notes.md", "--json"], f.io)).toBe(0);
  expect([...f.armada.launches.values()]).toEqual([
    expect.objectContaining({
      ticket: "DEMO-13",
      coordinator: "front",
      runtime: "conductor",
      runtimeHandle: "ws-1/ses-1",
    }),
  ]);
  const create = f.calls.find((c) => c.args[2] === "create");
  if (!create?.input) throw new Error("no native launch prompt");
  expect(create.args).toEqual([
    "--json",
    "workspace",
    "create",
    "--repo-url",
    "https://github.com/acme/widgets",
    "--branch",
    "trunk",
    "--name",
    "DEMO-13 Synthetic worker",
    "--session-name",
    "DEMO-13",
    "--agent",
    "codex",
    "--model",
    "synthetic-model",
    "--effort",
    "high",
    "--fast-mode",
    "--message-file",
    "-",
    "--env",
    "ARMADA_TICKET=DEMO-13",
  ]);
  expect(create.timeoutMs).toBe(120_000);
  expect(create.input).toContain(`armada login --launch-token ${CANARY}`);
  expect(create.input).toContain("## Coordinator notes\n\nFrom the coordinator, for this launch.");
  expect(create.input.indexOf("## Coordinator notes")).toBeGreaterThan(create.input.indexOf("## Ticket"));
  expect(create.input.indexOf("## Coordinator notes")).toBeGreaterThan(create.input.indexOf("## Parent"));
  expect(create.input.indexOf("## Coordinator notes")).toBeLessThan(create.input.indexOf("## Plan"));
  expect(create.input).toContain("Use the existing widget.");
  expect(create.input).toContain("Plans need the coordinator's approval");
  expect(f.reads).toContain("/work/widgets/nested/notes.md");
  expect(f.bindings).toEqual([
    { project: "widgets", ticket: "DEMO-13", id: "wk-1", runtime: "conductor", handle: "ws-1/ses-1" },
  ]);
  expect(JSON.parse(f.stdout())).toMatchObject({
    ticket: "DEMO-13",
    runtime: "conductor",
    profile: "backend",
    handle: "ws-1/ses-1",
    link: "conductor://workspace?id=ws-1&session=ses-1",
  });
  expect(f.output()).not.toContain("Use the existing widget.");
  expect(f.calls.flatMap((c) => c.args)).not.toContain(CANARY);
  expect(f.armada.calls.some((c) => c.path === "fleet/lease/release")).toBe(true);
});

test("notes and profile refusals mint no token", async () => {
  for (const notes of ["missing.md", "empty.md", "oversize.md"]) {
    const f = await fixture();
    f.files.set("/work/widgets/nested/empty.md", " \n\t");
    f.files.set("/work/widgets/nested/oversize.md", "é".repeat(8193));
    expect(await run(["launch", "DEMO-13", "--notes", notes], f.io)).toBe(2);
    expect(f.armada.launches.size).toBe(0);
    f.output();
  }
  const f = await fixture();
  expect(await run(["launch", "DEMO-13", "--profile", "unknown"], f.io)).toBe(2);
  expect(f.armada.launches.size).toBe(0);
});

test("known create failure revokes the exact launch and never leaks native output", async () => {
  const f = await fixture();
  f.set({ fail: 4 });
  await expect(f.launch()).rejects.toThrow("Conductor server error during workspace create (exit 4)");
  expect(f.revoked).toEqual(["wk-1"]);
  expect(f.bindings).toEqual([]);
  expect(f.output()).toContain("revoked the pending launch");
});

test("lost create answer recovers and binds one worker without creating twice", async () => {
  const f = await fixture();
  f.set({ timedOut: true });
  expect(await f.launch()).toBe(0);
  expect(f.calls.filter((c) => c.args[2] === "create")).toHaveLength(1);
  expect(f.calls.find((c) => c.args[2] === "list")?.args).toEqual([
    "--json",
    "workspace",
    "list",
    "--mine",
    "--repo",
    "acme/widgets",
    "--since",
    NOW.toISOString(),
    "--limit",
    "10",
  ]);
  expect(f.bindings).toHaveLength(1);
  expect(f.revoked).toEqual([]);
  expect(f.output()).toContain("recovered the Conductor workspace");
});

test("lost create with no recoverable worker revokes its token", async () => {
  const f = await fixture();
  f.set({ timedOut: true, matches: 0 });
  await expect(f.launch()).rejects.toThrow("Conductor request timed out");
  expect(f.revoked).toEqual(["wk-1"]);
  f.output();
});

test("dry run defaults to the profile runtime, reports settings and preflight and creates nothing", async () => {
  const f = await fixture();
  expect(await run(["launch", "DEMO-13", "--dry-run", "--notes", "-", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.stdout())).toMatchObject({
    runtime: "conductor",
    why: "conductor.default_profile",
    model: "synthetic-model",
    fastMode: true,
    preflight: { ready: true, pendingLaunch: false, inFlight: false },
  });
  expect(f.armada.launches.size).toBe(0);
  expect(f.calls.some((c) => c.args[2] === "create")).toBe(false);
  expect(f.armada.calls.some((c) => c.path.includes("lease/"))).toBe(false);
  expect(f.output()).not.toContain("Notes from stdin.");
});

test("preflight auth failure and completed tickets are refused before a token exists", async () => {
  const f = await fixture();
  f.set({ auth: false });
  await expect(f.launch()).rejects.toThrow("Conductor is not signed in");
  expect(f.armada.launches.size).toBe(0);
  const g = await fixture();
  g.ticket.state = { name: "Done", type: "completed" };
  await expect(g.launch()).rejects.toThrow("there is nothing to launch");
  expect(g.armada.launches.size).toBe(0);
});

test("guided Claude Code profile points to the Agent tool without minting a token", async () => {
  const f = await fixture(TOML.replace('agent = "codex"', 'runtime = "claude-code"\nagent = "claude"'));
  expect(await run(["launch", "DEMO-13"], f.io)).toBe(2);
  expect(f.output()).toContain("launch it with the Agent tool: armada brief DEMO-13 --prompt");
  expect(f.armada.launches.size).toBe(0);
});

test("an undeployed bind route warns and keeps the running worker", async () => {
  const f = await fixture();
  f.set({ bindingError: new ArmadaApiError("unavailable", null, false, 404) });
  expect(await f.launch()).toBe(0);
  expect(f.output()).toContain("launch binding is not deployed yet");
  expect(f.revoked).toEqual([]);
});

test("a pending launch, an active claim and an occupied lease all refuse before minting", async () => {
  for (const mode of ["pending", "active", "lease"] as const) {
    const f = await fixture();
    if (mode === "pending")
      f.store.launches.push({
        project: "widgets",
        ticket: "DEMO-13",
        launchedAt: NOW.toISOString(),
        runtime: "conductor",
        tokenUsedAt: null,
        handle: "ws-existing/s-existing",
        endedAt: null,
      });
    if (mode === "active")
      await f.store.saveRuntimeHandle({
        project: "widgets",
        ticket: "DEMO-13",
        runtime: "conductor",
        handle: "ws-existing/s-existing",
        branch: "feature/demo-13",
        at: NOW,
      });
    if (mode === "lease")
      await f.store.acquireLease({
        project: "widgets",
        name: "launch:DEMO-13",
        holder: "other-coordinator",
        ttlMs: 300_000,
        at: NOW,
      });
    await expect(f.launch()).rejects.toThrow(
      mode === "pending"
        ? "has not claimed yet"
        : mode === "active"
          ? "already in flight"
          : "another launch in progress",
    );
    expect(f.armada.launches.size).toBe(0);
    f.output();
  }
});

test("pending launch is rechecked after acquiring the lease", async () => {
  const f = await fixture();
  const acquire = f.store.acquireLease.bind(f.armada.store);
  f.store.acquireLease = async (input) => {
    const result = await acquire(input);
    f.store.launches.push({
      project: "widgets",
      ticket: "DEMO-13",
      launchedAt: NOW.toISOString(),
      runtime: null,
      tokenUsedAt: null,
      handle: null,
      endedAt: null,
    });
    return result;
  };
  await expect(f.launch()).rejects.toThrow("has not claimed yet");
  expect(f.armada.launches.size).toBe(0);
  expect(f.store.leases.size).toBe(0);
});

test("ambiguous recovery retains the pending token and gives the candidate ids without launching again", async () => {
  const f = await fixture();
  f.set({ timedOut: true, matches: 2 });
  await expect(f.launch()).rejects.toThrow("ws-1/ses-1, ws-2/ses-2");
  expect(f.revoked).toEqual([]);
  expect(f.calls.filter((c) => c.args[2] === "create")).toHaveLength(1);
  f.output();
});

test("configured Conductor project and base branch are passed explicitly", async () => {
  const f = await fixture(
    TOML.replace("[conductor]\n", '[conductor]\nproject_id = "project-1"\nbase_branch = "release/widget"\n'),
  );
  expect(await f.launch()).toBe(0);
  const args = f.calls.find((c) => c.args[2] === "create")?.args;
  expect(args).toContain("--project-id");
  expect(args).toContain("project-1");
  expect(args).toContain("release/widget");
  expect(args).not.toContain("--repo-url");
  expect(f.calls.some((c) => c.args[0] === "ls-remote")).toBe(false);
});

test("create runtime error recovers a possibly created workspace before cleanup", async () => {
  const f = await fixture();
  f.set({ fail: 1 });
  expect(await f.launch()).toBe(0);
  expect(f.bindings).toHaveLength(1);
  expect(f.revoked).toEqual([]);
  expect(f.calls.filter((c) => c.args[2] === "create")).toHaveLength(1);
});

test("recovery retains unmatched workspace and session names for inspection instead of guessing the ticket", async () => {
  const f = await fixture();
  f.set({ timedOut: true, renamed: true });
  await expect(f.launch()).rejects.toThrow("ws-1/ses-1");
  expect(f.bindings).toEqual([]);
  expect(f.revoked).toEqual([]);
  expect(f.calls.filter((c) => c.args[2] === "create")).toHaveLength(1);
  f.output();
});

test("truncated workspace or session recovery keeps the pending token and prints actionable ids", async () => {
  for (const field of ["workspaceMore", "sessionMore"] as const) {
    const f = await fixture();
    f.set({ timedOut: true, [field]: true });
    await expect(f.launch()).rejects.toThrow("ws-1");
    expect(f.revoked).toEqual([]);
    expect(f.bindings).toEqual([]);
    f.output();
  }
});

test("an unavailable or malformed recovery search retains the pending launch for manual inspection", async () => {
  for (const recoveryFailure of ["unavailable", "malformed"] as const) {
    const f = await fixture();
    f.set({ timedOut: true, recoveryFailure });
    await expect(f.launch()).rejects.toThrow("pending launch is retained");
    expect(f.revoked).toEqual([]);
    expect(f.bindings).toEqual([]);
    expect(f.calls.filter((c) => c.args[2] === "create")).toHaveLength(1);
    f.output();
  }
});

test("Conductor pre-approval is read-only in preview and reaches the launched brief", async () => {
  for (const dry of [true, false]) {
    const f = await fixture();
    f.io.env.ARMADA_COORDINATOR = "front";
    expect(
      await f.launch({ "pre-approve": "true", reason: "small follow-up", ...(dry ? { "dry-run": "true" } : {}) }),
    ).toBe(0);
    if (dry) {
      expect(JSON.parse(f.stdout()).preApproval).toContain("Would add plan-approved");
      expect(f.linear.writes).toHaveLength(0);
      expect(f.armada.launches.size).toBe(0);
    } else {
      expect([...f.armada.launches.values()][0]?.coordinator).toBe("front");
      expect(f.linear.writes).toHaveLength(1);
      expect(f.linear.tickets.get("DEMO-13")?.labels.some((l) => l.name === "plan-approved")).toBe(true);
      const prompt = f.calls.find((c) => c.command === "conductor" && c.args.includes("create"))?.input;
      expect(prompt).toContain("added at launch: small follow-up");
      expect(prompt).toContain("armada report implementing --plan-file -");
    }
  }
});

test("Conductor needs-approval labels refuse pre-approval before any token or native launch", async () => {
  const f = await fixture();
  f.linear.add("DEMO-13", { labels: [{ id: "needs", name: "needs-plan-approval", group: null }] });
  await expect(f.launch({ "pre-approve": "true", reason: "small follow-up" })).rejects.toThrow(
    "remove needs-plan-approval first",
  );
  expect(f.linear.writes).toHaveLength(0);
  expect(f.armada.launches.size).toBe(0);
  expect(f.calls).toHaveLength(0);
});

test("a full worker cap refuses creation, offers queue/override, and records explicit or urgent bypasses", async () => {
  for (const bypass of [null, "owner approved another worker", "urgent"] as const) {
    const f = await fixture(`${TOML}\n[policy]\nmax_workers = 2\n`);
    for (const ticket of ["DEMO-7", "DEMO-8"])
      await f.store.saveRuntimeHandle({
        project: "widgets",
        ticket,
        runtime: "Conductor",
        handle: `ws/${ticket}`,
        branch: null,
        at: NOW,
        coordinator: ticket === "DEMO-7" ? "front" : "back",
      });
    if (bypass === "urgent") Object.assign(f.ticket, { priority: 1 });
    const args = ["launch", "DEMO-13", ...(bypass && bypass !== "urgent" ? ["--over-cap", bypass] : [])];
    expect(await run(args, f.io)).toBe(bypass ? 0 : 1);
    const token = f.armada.calls.find((c) => c.path === "launch-tokens");
    if (!bypass) {
      expect(token).toBeUndefined();
      expect(f.calls.some((c) => c.command === "conductor" && c.args.includes("create"))).toBe(false);
      expect(f.stderr()).toContain(
        'Next: armada launch DEMO-13 --when-unblocked or armada launch DEMO-13 --over-cap "<why>"',
      );
    } else {
      expect(token?.body).toMatchObject({
        overCap: `launched over the cap (3 of 2): ${bypass === "urgent" ? "urgent priority" : bypass}`,
      });
    }
    expect(await f.store.getLease("widgets", "launch-slots")).toBeNull();
  }
});

test("brief --prompt at the cap fails without printing a token or a key-based launch prompt", async () => {
  const f = await fixture(`${TOML}\n[policy]\nmax_workers = 1\n`);
  await f.store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-7",
    runtime: "Conductor",
    handle: "ws/7",
    branch: null,
    at: NOW,
  });
  expect(await run(["brief", "DEMO-13", "--prompt"], f.io)).toBe(1);
  expect(f.stdout()).toBe("");
  expect(f.armada.calls.some((c) => c.path === "launch-tokens")).toBe(false);
});

test("dry run reads a full cap without acquiring a lease or creating anything", async () => {
  const f = await fixture(`${TOML}\n[policy]\nmax_workers = 1\n`);
  await f.store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-7",
    runtime: "Conductor",
    handle: "ws/7",
    branch: null,
    at: NOW,
  });
  expect(await run(["launch", "DEMO-13", "--dry-run"], f.io)).toBe(1);
  expect(f.stderr()).toContain("would be refused: 1 of 1");
  expect(f.armada.calls.some((c) => c.path === "launch-tokens" || c.path.endsWith("lease/acquire"))).toBe(false);
});

test("concurrent token mints reserve the last slot before releasing its lease; replacements are exempt", async () => {
  const { mintLaunchToken } = await import("../src/worker-slots.ts");
  const f = await fixture(`${TOML}\n[policy]\nmax_workers = 1\n`);
  const credentials = resolveCredentials({ env: f.io.env });
  const config = parseConfig(`${TOML}\n[policy]\nmax_workers = 1\n`);
  const sleeps: number[] = [];
  const io = {
    ...f.io,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      await Promise.resolve();
    },
  };
  const results = await Promise.allSettled([
    mintLaunchToken(io, config, credentials, { ticket: "DEMO-13" }),
    mintLaunchToken(io, config, credentials, { ticket: "DEMO-14" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.armada.calls.filter((c) => c.path === "launch-tokens")).toHaveLength(1);
  expect(await f.store.pendingLaunches("widgets", new Date(0))).toHaveLength(1);
  expect(sleeps.every((ms) => ms === 1000)).toBe(true);
  await expect(
    mintLaunchToken(io, config, credentials, { ticket: "DEMO-13", replacement: true }),
  ).resolves.toBeDefined();
});

test("a worker claiming during the slot read cannot disappear from the cap", async () => {
  const { mintLaunchToken } = await import("../src/worker-slots.ts");
  const f = await fixture(`${TOML}\n[policy]\nmax_workers = 1\n`);
  f.store.launches.push({
    project: "widgets",
    ticket: "DEMO-7",
    launchedAt: NOW.toISOString(),
    tokenUsedAt: NOW.toISOString(),
    runtime: null,
    handle: null,
    endedAt: null,
  });
  const originalFetch = f.io.fetch;
  if (!originalFetch) throw new Error("fixture needs fetch");
  const io = {
    ...f.io,
    fetch: async (url: string, init: Parameters<NonNullable<Io["fetch"]>>[1]) => {
      if (url.endsWith("/fleet/launches")) {
        await f.store.saveRuntimeHandle({
          project: "widgets",
          ticket: "DEMO-7",
          runtime: "Conductor",
          handle: "ws/7",
          branch: null,
          at: NOW,
        });
        await f.store.recordEvent({
          project: "widgets",
          ticket: "DEMO-7",
          kind: "claim",
          phase: "implementing",
          at: NOW,
        });
      }
      return originalFetch(url, init);
    },
  };
  await expect(
    mintLaunchToken(io, parseConfig(`${TOML}\n[policy]\nmax_workers = 1\n`), resolveCredentials({ env: io.env }), {
      ticket: "DEMO-13",
    }),
  ).rejects.toThrow("worker cap reached: 1 of 1");
  expect(f.armada.calls.some((c) => c.path === "launch-tokens")).toBe(false);
});

test("an unknown slot lease acquisition only mints after confirming its own grant", async () => {
  const { mintLaunchToken } = await import("../src/worker-slots.ts");
  for (const outcome of ["granted", "busy", "unavailable"] as const) {
    const f = await fixture(`${TOML}\n[policy]\nmax_workers = 1\n`);
    if (outcome === "busy")
      await f.store.acquireLease({ project: "widgets", name: "launch-slots", holder: "peer", ttlMs: 60_000, at: NOW });
    const originalFetch = f.io.fetch;
    if (!originalFetch) throw new Error("missing fake API");
    const io = {
      ...f.io,
      fetch: async (url: string, init: Parameters<NonNullable<Io["fetch"]>>[1]) => {
        if (url.endsWith("/fleet/lease/acquire")) {
          if (outcome !== "unavailable") await originalFetch(url, init);
          throw new Error("lease response lost");
        }
        return originalFetch(url, init);
      },
    };
    const result = mintLaunchToken(
      io,
      parseConfig(`${TOML}\n[policy]\nmax_workers = 1\n`),
      resolveCredentials({ env: io.env }),
      { ticket: "DEMO-13", overCap: "owner approved" },
    );
    if (outcome === "granted") await expect(result).resolves.toBeDefined();
    else await expect(result).rejects.toThrow("cannot confirm worker-slot lease");
    expect(f.armada.calls.filter((c) => c.path === "launch-tokens")).toHaveLength(outcome === "granted" ? 1 : 0);
  }
});

test("an unknown token write retains the slot lease until expiry; a definite refusal releases it", async () => {
  const { mintLaunchToken } = await import("../src/worker-slots.ts");
  for (const outcome of ["delayed-write", "refused"] as const) {
    const f = await fixture(`${TOML}\n[policy]\nmax_workers = 1\n`);
    const originalFetch = f.io.fetch;
    if (!originalFetch) throw new Error("missing fake API");
    let delayedWrite: (() => ReturnType<NonNullable<Io["fetch"]>>) | undefined;
    const io = {
      ...f.io,
      sleep: async () => {},
      fetch: async (url: string, init: Parameters<NonNullable<Io["fetch"]>>[1]) => {
        if (url.endsWith("/launch-tokens")) {
          if (outcome === "refused") return new Response(JSON.stringify({ error: "invalid launch" }), { status: 400 });
          delayedWrite = () => originalFetch(url, init);
          throw new Error("token response lost");
        }
        return originalFetch(url, init);
      },
    };
    const config = parseConfig(`${TOML}\n[policy]\nmax_workers = 1\n`);
    const credentials = resolveCredentials({ env: io.env });
    await expect(mintLaunchToken(io, config, credentials, { ticket: "DEMO-13" })).rejects.toThrow();
    expect(await f.store.pendingLaunches("widgets", new Date(0))).toHaveLength(0);
    if (outcome === "delayed-write") {
      if (!delayedWrite) throw new Error("token write was not attempted");
      expect(await f.store.getLease("widgets", "launch-slots")).not.toBeNull();
      await expect(
        mintLaunchToken({ ...io, fetch: originalFetch }, config, credentials, { ticket: "DEMO-14" }),
      ).rejects.toThrow("another launch is counting worker slots");
      await delayedWrite();
      expect(await f.store.pendingLaunches("widgets", new Date(0))).toHaveLength(1);
    } else {
      expect(await f.store.getLease("widgets", "launch-slots")).toBeNull();
      await expect(
        mintLaunchToken({ ...io, fetch: originalFetch }, config, credentials, { ticket: "DEMO-14" }),
      ).resolves.toBeDefined();
    }
  }
});
