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
    models?: string;
    pane?: string;
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
  let configText = options.toml ?? local;
  const writes: { path: string; text: string }[] = [];
  let workerConfig = DEMO_TOML;
  const io: Io = {
    cwd: "/work/widgets/subfolder",
    env: { XDG_CONFIG_HOME: home, ARMADA_API_URL: ARMADA_URL },
    readFile: async (p) =>
      p === "/work/widgets/armada.toml"
        ? configText
        : p === "/work/worktrees/demo-13/armada.toml"
          ? workerConfig
          : null,
    writeFile: async (path, text) => {
      if (path === "/work/widgets/armada.toml") configText = text;
      else if (path === "/work/worktrees/demo-13/armada.toml") workerConfig = text;
      else throw new Error("unexpected config path");
      writes.push({ path, text });
    },
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
      if (command === "opencode" && args.includes("--verbose")) {
        const ids = (
          options.models ?? "opencode/deepseek-v4-pro\nopencode/deepseek-v4-flash\nopenrouter/deepseek/deepseek-chat"
        )
          .split("\n")
          .filter(Boolean);
        return {
          code: 0,
          stdout: ids
            .map((id) => {
              const slash = id.indexOf("/");
              return `${id}\n${JSON.stringify({ providerID: id.slice(0, slash), id: id.slice(slash + 1), name: id.slice(slash + 1) }, null, 2)}\n`;
            })
            .join(""),
          stderr: "",
        };
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "read") {
        const start = calls.find((call) => call[1] === "agent" && call[2] === "start");
        const id = start?.[start.indexOf("--model") + 1] ?? "";
        return {
          code: 0,
          stdout: options.pane ?? `Build auto · ${id.slice(id.indexOf("/") + 1)} OpenCode Zen\n╹`,
          stderr: "",
        };
      }
      if (command === "opencode" && args[0] === "models")
        return {
          code: 0,
          stdout:
            options.models ??
            "opencode/deepseek-v4-pro\nopencode/deepseek-v4-flash\nopenrouter/deepseek/deepseek-chat\n",
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
    writes,
    configText: () => configText,
    workerConfig: () => workerConfig,
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

const deepseekLocal = local
  .replace('harness = "codex"', 'harness = "deepseek"')
  .replace('model = "model-a"', 'model = "opencode/deepseek-v4-pro"')
  .replace('extra_args = ["--sandbox", "workspace-write"]', "extra_args = []");

test("DeepSeek launch and worker claim explicitly identify the OpenCode fallback", async () => {
  const f = await fixture({ toml: deepseekLocal });
  expect(
    await run(["launch", "DEMO-13", "--runtime", "herdr", "--harness", "deepseek", "--json"], f.io),
    f.errors(),
  ).toBe(0);
  expect(JSON.parse(f.output())).toMatchObject({
    harness: "deepseek",
    actualHarness: "opencode",
    harnessDescription: "deepseek (OpenCode + DeepSeek model)",
  });
  expect(f.calls.find((call) => call[1] === "agent" && call[2] === "start")).toContain("opencode");
  expect(f.prompt()).toContain("deepseek (OpenCode + DeepSeek model)");
  const worker: Io = {
    ...f.io,
    cwd: "/work/worktrees/demo-13",
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
  expect(f.linear.bodies.some((body) => body.includes("agent deepseek (OpenCode + DeepSeek model)"))).toBe(true);
  expect(f.calls.filter((call) => call[0] === "dsh")).toEqual([]);
});

test("a different available DeepSeek model does not launch the configured worker", async () => {
  const f = await fixture({ toml: deepseekLocal, models: "opencode/deepseek-v4-flash" });
  expect(await run(["launch", "DEMO-13", "--runtime", "herdr", "--harness", "deepseek"], f.io)).toBe(1);
  expect(f.errors()).toContain("/connect");
  expect(f.armada.launches.size).toBe(0);
  expect(f.calls.some((call) => call[1] === "worktree" || call[1] === "status")).toBe(false);
});

test("interactive launch saves the chosen exact DeepSeek model and starts that model", async () => {
  const f = await fixture({
    toml: deepseekLocal.replace('model = "opencode/deepseek-v4-pro"', "# choose a model"),
    models: "openai/model-a\nopencode/deepseek-v4.1-flash\nopenrouter/deepseek/deepseek-chat",
  });
  f.io.interactive = true;
  f.io.prompt = async (question) => {
    expect(question).toContain("Model number");
    return "1";
  };
  expect(await run(["launch", "DEMO-13", "--runtime", "herdr", "--harness", "deepseek"], f.io), f.errors()).toBe(0);
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1]?.path).toBe("/work/worktrees/demo-13/armada.toml");
  expect(f.workerConfig()).toBe(f.configText());
  expect(f.configText()).toContain('model = "opencode/deepseek-v4.1-flash"');
  expect(f.configText()).toContain("# choose a model");
  expect(f.calls.find((call) => call[1] === "agent" && call[2] === "start")).toContain("opencode/deepseek-v4.1-flash");
  expect(f.prompt()).toContain("opencode/deepseek-v4.1-flash");
});

test("JSON launch never prompts or writes a missing OpenCode model", async () => {
  const f = await fixture({ toml: deepseekLocal.replace('model = "opencode/deepseek-v4-pro"', "") });
  f.io.interactive = true;
  f.io.prompt = async () => {
    throw new Error("unexpected prompt");
  };
  expect(await run(["launch", "DEMO-13", "--runtime", "herdr", "--json"], f.io)).toBe(1);
  expect(f.writes).toEqual([]);
  expect(f.armada.launches.size).toBe(0);
  expect(f.errors()).toContain("Available models:");
  expect(f.errors()).toContain('model = "<exact model id>"');
});

test("a newly selected model/profile is copied to the actual worker worktree before it claims", async () => {
  const f = await fixture({
    toml: deepseekLocal.replace('model = "opencode/deepseek-v4-pro"', ""),
    models: "opencode/deepseek-v4.1-flash",
  });
  f.io.interactive = true;
  f.io.prompt = async () => "1";
  expect(await run(["launch", "DEMO-13", "--runtime", "herdr"], f.io), f.errors()).toBe(0);
  expect(f.workerConfig()).toContain('model = "opencode/deepseek-v4.1-flash"');
  const worker: Io = {
    ...f.io,
    cwd: "/work/worktrees/demo-13",
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
  expect(f.linear.bodies.some((body) => body.includes("model opencode/deepseek-v4.1-flash"))).toBe(true);
});

test("failed worker config delivery prevents the harness from starting and never logs config content", async () => {
  const f = await fixture({ toml: deepseekLocal });
  f.io.writeFile = async () => {
    throw new Error("CANARY_private_config");
  };
  expect(await run(["launch", "DEMO-13", "--runtime", "herdr"], f.io)).toBe(2);
  expect(f.calls.some((call) => call[1] === "agent")).toBe(false);
  expect(f.errors()).toContain("local workspace retained");
  expect(f.errors()).not.toContain("CANARY_private_config");
});

test("launch refuses an OpenCode fallback before delivering the worker token", async () => {
  const f = await fixture({ toml: deepseekLocal, pane: "Build auto · deepseek-v4-flash OpenCode Zen\n╹" });
  expect(await run(["launch", "DEMO-13", "--runtime", "herdr"], f.io)).toBe(2);
  expect(f.errors()).toContain("model differs from profile opencode/deepseek-v4-pro");
  expect(f.errors()).toContain("worker pane closed");
  expect(f.errors()).toContain("armada launch revoke DEMO-13");
  expect(f.prompt()).toBe("");
  expect(f.calls.at(-1)).toEqual(["herdr", "pane", "close", f.handle.pane]);
  expect(f.errors()).not.toContain("armada_launch_CANARY_1");
});
