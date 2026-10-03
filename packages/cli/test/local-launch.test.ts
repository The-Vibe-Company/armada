import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrClaimHandle, machinePaths, readWatchState } from "@armada/core";
import { ARMADA_URL, DEMO_TOML, FakeLinear, fakeArmada, NOW, recordedFetch } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const local = `${DEMO_TOML}
[herdr]
default_profile = "backend"
[herdr.profiles.backend]
harness = "codex"
model = "model-a"
effort = "high"
extra_args = ["--sandbox", "workspace-write"]
`;
const rawTicket = () => ({
  identifier: "DEMO-13",
  title: "Show a sign-in page",
  url: "https://linear.app/acme/issue/DEMO-13",
  branchName: "feature/demo-13",
  description: `## In short\n${"Use quotes ' \" and $(touch never)\n".repeat(100)}`,
  state: { name: "Todo", type: "unstarted" },
  labels: { nodes: [{ name: "api" }], pageInfo: { hasNextPage: false } },
  parent: null,
  comments: { nodes: [], pageInfo: { hasNextPage: false } },
  inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
});
async function fixture(
  options: {
    toml?: string;
    missing?: boolean;
    promptFailure?: boolean;
    unsigned?: boolean;
    state?: string;
    unpublished?: boolean;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "armada-local-"));
  homes.push(home);
  await mkdir(join(home, "armada"));
  await writeFile(
    join(home, "armada", "credentials"),
    `ARMADA_SESSION_TOKEN=CANARY_coordinator\nARMADA_SIGNED_IN_TO=${ARMADA_URL}\n`,
  );
  const armada = fakeArmada({ vault: { linear: { apiKey: "lin_api_CANARY", scope: "own" }, now: () => NOW } });
  armada.sessions.add("CANARY_coordinator");
  const ticket = rawTicket();
  if (options.state) ticket.state = { name: "Done", type: options.state };
  const recorded = recordedFetch({
    ...(options.unpublished
      ? { npm: { versions: { "0.0.1": { dist: { tarball: "https://registry.npmjs.org/old.tgz" } } } } }
      : {}),
    linear: (r) => {
      Object.assign(r, { Brief: [{ data: { issue: ticket } }] });
    },
  });
  const linear = new FakeLinear();
  linear.add("DEMO-13", { branchName: "feature/demo-13" });
  const output: string[] = [],
    errors: string[] = [],
    calls: string[][] = [];
  let prompt = "";
  const handle = { workspace: "w8", pane: "w8:p9", agent: "demo-13" };
  const io: Io = {
    cwd: "/work/widgets/subfolder",
    env: { XDG_CONFIG_HOME: home, ARMADA_API_URL: ARMADA_URL },
    readFile: async (p) => (p === "/work/widgets/armada.toml" ? (options.toml ?? local) : null),
    stdout: (t) => output.push(t),
    stderr: (t) => errors.push(t),
    ghToken: () => null,
    now: () => NOW,
    linearWriter: () => linear,
    fetch: (url, init) =>
      url === "https://registry.npmjs.org/old.tgz"
        ? Promise.resolve(new Response(null, { status: 200 }))
        : url.startsWith(ARMADA_URL)
          ? armada.fetch(url, init)
          : recorded.fetch(url, init),
    exec: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "--version") return { code: options.missing ? 1 : 0, stdout: `${command} 0.9.1`, stderr: "" };
      if (command === "codex" && args[0] === "login")
        return {
          code: options.unsigned ? 1 : 0,
          stdout: options.unsigned ? "Not logged in" : "Logged in using ChatGPT",
          stderr: "",
        };
      if (command === "git")
        return {
          code: 0,
          stdout: args[0] === "rev-parse" ? "/work/widgets\n" : "ref: refs/heads/trunk\tHEAD\n",
          stderr: "",
        };
      let reply: unknown;
      if (args[0] === "status") reply = { server: { running: true, compatible: true } };
      else if (args[0] === "worktree")
        reply = {
          result: {
            workspace: { workspace_id: handle.workspace },
            root_pane: { workspace_id: handle.workspace, pane_id: "w8:p3" },
            worktree: { path: "/work/worktrees/demo-13" },
          },
        };
      else if (args[0] === "pane") reply = { result: { type: "ok" } };
      else if (args[0] === "tab")
        reply = { result: { root_pane: { workspace_id: handle.workspace, pane_id: handle.pane } } };
      else {
        if (args[1] === "prompt") {
          prompt = args[3] ?? "";
          if (options.promptFailure) throw new Error(prompt);
        }
        reply = {
          result: {
            agent: {
              name: handle.agent,
              pane_id: handle.pane,
              workspace_id: handle.workspace,
              agent_status: args[1] === "prompt" ? "working" : "idle",
            },
          },
        };
      }
      return { code: 0, stdout: JSON.stringify(reply), stderr: "" };
    },
  };
  return {
    io,
    armada,
    linear,
    calls,
    output: () => output.join(""),
    errors: () => errors.join(""),
    prompt: () => prompt,
    handle,
    home,
  };
}

test("one launch supplies the herdr brief, then worker login/claim records the returned handle", async () => {
  const f = await fixture();
  expect(await run(["launch", "demo-13", "--runtime", "herdr", "--harness", "codex", "--json"], f.io)).toBe(0);
  const result = JSON.parse(f.output());
  expect(result).toMatchObject({
    ticket: "DEMO-13",
    runtime: "herdr",
    handle: herdrClaimHandle(f.handle),
    branch: "feature/demo-13",
    state: "working",
  });
  expect(f.calls.find((call) => call[1] === "worktree")).toContain("trunk");
  const prompt = f.prompt();
  expect(prompt).toContain("armada login --launch-token armada_launch_CANARY_1");
  expect(prompt).toContain(
    `armada claim DEMO-13 --runtime herdr --handle '${herdrClaimHandle(f.handle)}' --branch feature/demo-13 --profile backend`,
  );
  expect(prompt).toContain(`--ticket DEMO-13 --handle '${herdrClaimHandle(f.handle)}'`);
  expect(prompt).toContain("Herdr already created your own worktree");
  expect(prompt).not.toContain("git branch -m");
  expect(prompt).not.toContain("CONDUCTOR_WORKSPACE");
  expect(prompt).toContain("Pass `--ticket DEMO-13`");
  const paths = machinePaths(f.io.env);
  if (!paths) throw new Error("missing paths");
  expect((await readWatchState(paths, "widgets"))?.inFlight).toContain("DEMO-13");
  const worker: Io = {
    ...f.io,
    env: { XDG_CONFIG_HOME: join(f.home, "worker"), ARMADA_API_URL: ARMADA_URL },
    gitBranch: () => "feature/demo-13",
  };
  expect(await run(["login", "--launch-token", "armada_launch_CANARY_1", "--api-url", ARMADA_URL], worker)).toBe(0);
  expect(
    await run(
      ["claim", "DEMO-13", "--runtime", "herdr", "--handle", herdrClaimHandle(f.handle), "--profile", "backend"],
      worker,
    ),
    f.errors(),
  ).toBe(0);
  expect(f.linear.bodies.some((body) => body.includes(`runtime: Herdr · session: ${herdrClaimHandle(f.handle)}`))).toBe(
    true,
  );
  expect(await f.armada.store.getRuntimeHandle("widgets", "DEMO-13")).toMatchObject({
    runtime: "Herdr",
    handle: herdrClaimHandle(f.handle),
    profile: "backend",
  });
  for (const secret of ["armada_launch_CANARY_1", "lin_api_CANARY", "CANARY_coordinator"])
    expect(f.output() + f.errors()).not.toContain(secret);
});

test("missing prerequisites and mismatched harness never create a token or runtime", async () => {
  for (const missing of [true, false]) {
    const f = await fixture({ missing });
    expect(
      await run(["launch", "DEMO-13", "--runtime", "herdr", "--harness", missing ? "codex" : "claude"], f.io),
    ).toBe(missing ? 1 : 2);
    expect(f.armada.launches.size).toBe(0);
    expect(f.calls.some((call) => call[1] === "status" || call[1] === "worktree")).toBe(false);
  }
});

test("policy decisions and completed tickets are rejected before token creation", async () => {
  for (const options of [
    { state: "completed" },
    { toml: `${local}\n[[policy.validation]]\nwhen="design"\nthen="show the owner"` },
  ]) {
    const f = await fixture(options);
    expect(await run(["launch", "DEMO-13", "--runtime", "herdr"], f.io)).toBe(2);
    expect(f.armada.launches.size).toBe(0);
    expect(f.calls).toEqual([]);
  }
});

test("a failed prompt retains the workspace, tells how to revoke and never leaks its token", async () => {
  const f = await fixture({ promptFailure: true });
  expect(await run(["launch", "DEMO-13", "--runtime", "herdr"], f.io)).toBe(2);
  expect(f.errors()).toContain("local workspace retained");
  expect(f.errors()).toContain("armada launch revoke DEMO-13");
  expect(f.output() + f.errors()).not.toContain("armada_launch_CANARY_1");
});

test("an unpublished CLI never launches a worker with an older package's profile rules", async () => {
  const f = await fixture({ unpublished: true });
  expect(await run(["launch", "DEMO-13", "--runtime", "herdr"], f.io)).toBe(2);
  expect(f.errors()).toContain("publish this version");
  expect(f.armada.launches.size).toBe(0);
  expect(f.calls.some((call) => call[1] === "worktree" || call[1] === "status")).toBe(false);
});

test("shared preflight blocks known missing sign-in before token/runtime creation", async () => {
  const f = await fixture({ unsigned: true });
  expect(await run(["launch", "DEMO-13", "--runtime", "herdr"], f.io)).toBe(1);
  expect(f.errors()).toContain("codex is not signed in");
  expect(f.armada.launches.size).toBe(0);
  expect(f.calls.some((call) => call[1] === "status" || call[1] === "worktree")).toBe(false);
});

test("JSON launch never prompts or installs even on an interactive terminal", async () => {
  const f = await fixture({ missing: true });
  f.io.interactive = true;
  let questions = 0,
    installs = 0;
  f.io.prompt = async () => {
    questions++;
    return "y";
  };
  f.io.spawn = async () => {
    installs++;
    return 0;
  };
  expect(await run(["launch", "DEMO-13", "--runtime", "herdr", "--json"], f.io)).toBe(1);
  expect(f.armada.launches.size).toBe(0);
  expect(questions).toBe(0);
  expect(installs).toBe(0);
  expect(f.calls.some((call) => call[1] === "status" || call[1] === "worktree" || call[1] === "agent")).toBe(false);
});
