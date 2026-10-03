import { describe, expect, test } from "bun:test";
import { localRuntimeChecks, renderDoctor } from "../src/doctor.ts";
import type { ExecResult, Io } from "../src/io.ts";
import {
  checkLocalTools,
  detectLocalTools,
  ensureLocalTools,
  localHarnesses,
  offerLocalInstalls,
} from "../src/local-tools.ts";

const ok = (stdout: string, stderr = ""): ExecResult => ({ code: 0, stdout, stderr });
const CANARY = "CANARY_private_status_token";

function terminal(responses: Record<string, ExecResult | Error>, answers: (string | null)[] = []) {
  const calls: string[] = [];
  const output: string[] = [];
  const prompts: string[] = [];
  const installs: [string, string[]][] = [];
  const io: Io = {
    cwd: "/work/widgets",
    env: {},
    readFile: async () => null,
    ghToken: () => null,
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
    interactive: true,
    prompt: async (question, options) => {
      expect(options.hidden).toBe(false);
      prompts.push(question);
      return answers.shift() ?? null;
    },
    exec: async (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      const response = responses[key] ?? Object.assign(new Error(CANARY), { code: "ENOENT" });
      if (response instanceof Error) throw response;
      return response;
    },
    spawn: async (command, args) => {
      installs.push([command, args]);
      return 0;
    },
  };
  return { io, calls, prompts, installs, output, responses };
}

describe("local tool detection", () => {
  test("missing tools have official installers, deduplicated by binary", async () => {
    const t = terminal({});
    const result = await detectLocalTools(t.io, ["claude", "codex", "opencode", "deepseek", "codex"]);
    expect(result.ready).toBe(false);
    expect(result.tools.map((tool) => tool.command)).toEqual(["herdr", "claude", "codex", "opencode"]);
    expect(result.tools.map((tool) => tool.install)).toEqual([
      "curl -fsSL https://herdr.dev/install.sh | sh",
      "curl -fsSL https://claude.ai/install.sh | bash",
      "npm i -g @openai/codex",
      "curl -fsSL https://opencode.ai/install | bash",
    ]);
    expect(result.checks.every((check) => check.level === "error" && check.fix)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(t.calls.every((call) => call.endsWith(" --version"))).toBe(true);
  });

  test("herdr requires stable 0.9.1; bad exits and unrecognized output cannot pass", async () => {
    for (const [response, ready] of [
      [ok("herdr 0.9.0\n"), false],
      [ok("herdr 0.9.1\n"), true],
      [ok("herdr 0.9.3\n"), true],
      [ok("herdr 0.9.1-rc.1\n"), false],
      [ok("herdr unknown\n"), false],
      [{ code: 1, stdout: "herdr 0.9.3", stderr: CANARY }, false],
      [Object.assign(new Error(CANARY), { code: "EACCES" }), false],
    ] as const) {
      const t = terminal({ "herdr --version": response });
      const result = await detectLocalTools(t.io, []);
      expect(result.ready).toBe(ready);
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
  });

  test("checks each harness status and the specific DeepSeek connection", async () => {
    const t = terminal({
      "herdr --version": ok("herdr 0.9.1"),
      "claude --version": ok("2.1.100 (Claude Code)"),
      "claude auth status": ok(JSON.stringify({ loggedIn: true, email: CANARY })),
      "codex --version": ok("codex-cli 0.128.0"),
      "codex login status": ok("", `Logged in using API key - ${CANARY}`),
      "opencode --version": ok("1.2.0"),
      "opencode auth list": ok("●  DeepSeek api\n└  1 credentials\n"),
      "dsh --version": ok("0.1.7"),
    });
    const result = await detectLocalTools(t.io, ["claude", "codex", "opencode", "deepseek"]);
    expect(result.ready).toBe(true);
    expect(result.checks.filter((check) => check.id.endsWith("-sign-in")).map((check) => check.level)).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
    expect(result.checks.at(-1)?.message).toContain("saved DeepSeek connection");
    expect(t.calls.filter((call) => call.startsWith("dsh"))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  test("known missing sign-in blocks launch and only names an owner command", async () => {
    for (const [harness, command, status, response, login] of [
      [
        "claude",
        "claude",
        "auth status",
        { code: 1, stdout: '{"loggedIn":false}', stderr: CANARY },
        "claude auth login",
      ],
      ["codex", "codex", "login status", { code: 1, stdout: "", stderr: "Not logged in" }, "codex login"],
      ["opencode", "opencode", "auth list", ok("└  0 credentials\n"), "opencode auth login"],
    ] as const) {
      const t = terminal({
        "herdr --version": ok("0.9.1"),
        [`${command} --version`]: ok("1.2.0"),
        [`${command} ${status}`]: response,
      });
      expect(await ensureLocalTools(t.io, harness)).toBe(false);
      expect(t.output.join("")).toContain(login);
      expect(t.output.join("")).not.toContain(CANARY);
      expect(t.prompts).toEqual([]);
      expect(t.installs).toEqual([]);
      expect(t.calls).not.toContain(login);
    }
  });

  test("unknown auth, diagnostic failures and environment-only OpenCode auth are not a false missing login", async () => {
    for (const response of [ok("unexpected"), { code: 2, stdout: "", stderr: CANARY }, new Error(CANARY)]) {
      const t = terminal({
        "herdr --version": ok("0.9.1"),
        "claude --version": ok("2.1.100"),
        "claude auth status": response,
      });
      const result = await detectLocalTools(t.io, ["claude"]);
      expect(result.ready).toBe(true);
      expect(result.checks.at(-1)?.message).toContain("could not check sign-in");
    }
    const t = terminal({
      "herdr --version": ok("0.9.1"),
      "opencode --version": ok("1.2.0"),
      "opencode auth list": ok("└  0 credentials\n└  1 environment variable\n"),
    });
    expect((await detectLocalTools(t.io, ["opencode"])).checks.at(-1)?.level).toBe("ok");
  });

  test("without an exec adapter detection is unknown, never a claim the tools are missing", async () => {
    const t = terminal({});
    delete t.io.exec;
    const result = await detectLocalTools(t.io, ["codex"]);
    expect(result.ready).toBe(false);
    expect(result.checks.every((check) => check.message.includes("could not check"))).toBe(true);
    await offerLocalInstalls(t.io, result);
    expect(t.prompts).toEqual([]);
  });
});

describe("local install offers", () => {
  test("declines, empty answers and cancellation run no install; cancellation ends the prompts", async () => {
    for (const answer of ["n", "", "yes please", null]) {
      const t = terminal({}, [answer, "n"]);
      expect(await checkLocalTools(t.io, { harness: "codex" })).toBe(false);
      expect(t.installs).toEqual([]);
      expect(t.prompts[0]).toContain("install now? [y/N]");
      if (answer === null) expect(t.prompts).toHaveLength(1);
    }
  });

  test("installs only accepted tools, rechecks and does not execute login", async () => {
    const t = terminal({ "herdr --version": ok("0.9.1") }, ["YES"]);
    t.io.spawn = async (command, args) => {
      t.installs.push([command, args]);
      t.responses["codex --version"] = ok("codex-cli 0.128.0");
      t.responses["codex login status"] = { code: 1, stdout: "", stderr: "Not logged in" };
      return 0;
    };
    expect(await ensureLocalTools(t.io, "codex")).toBe(false);
    expect(t.installs).toEqual([["npm", ["i", "-g", "@openai/codex"]]]);
    expect(t.output.join("")).toContain("codex login");
    expect(t.calls.filter((call) => call === "codex --version")).toHaveLength(2);
  });

  test("failed installs or an unchanged PATH stay gaps, without printing raw errors", async () => {
    for (const outcome of [1, 0, new Error(CANARY)]) {
      const t = terminal({ "herdr --version": ok("0.9.1") }, ["y"]);
      t.io.spawn = async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      };
      expect(await ensureLocalTools(t.io, "codex")).toBe(false);
      expect(t.output.join("")).not.toContain(CANARY);
      expect(t.output.join("")).toContain(outcome === 0 ? "PATH" : "installation failed");
    }
  });

  test("non-TTY, CI, JSON/read-only and missing prompt or spawn never mutate", async () => {
    for (const mode of ["non-tty", "ci", "json", "no-prompt", "no-spawn", "unsupported-host"]) {
      const t = terminal({}, ["yes", "yes"]);
      if (mode === "non-tty") t.io.interactive = false;
      if (mode === "ci") t.io.env.CI = "true";
      if (mode === "no-prompt") delete t.io.prompt;
      if (mode === "no-spawn") delete t.io.spawn;
      if (mode === "unsupported-host") t.io.platform = "win32";
      const result = await detectLocalTools(t.io, ["codex"]);
      await offerLocalInstalls(t.io, result, { readOnly: mode === "json" });
      expect(t.prompts).toEqual([]);
      expect(t.installs).toEqual([]);
    }
  });

  test("official installers receive paths but no terminal credentials or provider keys", async () => {
    const t = terminal({ "herdr --version": ok("0.9.1") }, ["y"]);
    t.io.env = {
      PATH: "/usr/bin",
      HOME: "/home/owner",
      XDG_CONFIG_HOME: "/tmp/config",
      npm_config_prefix: "/tmp/npm",
      OPENAI_API_KEY: CANARY,
      ANTHROPIC_API_KEY: CANARY,
      LINEAR_API_KEY: CANARY,
      GITHUB_TOKEN: CANARY,
      ARMADA_SESSION_TOKEN: CANARY,
      ARMADA_WORKER_SESSION_DEMO_7: CANARY,
      NPM_TOKEN: CANARY,
      UNRECOGNIZED_SECRET: CANARY,
    };
    t.io.spawn = async (_command, _args, options) => {
      expect(options.env).toEqual({
        PATH: "/usr/bin",
        HOME: "/home/owner",
        XDG_CONFIG_HOME: "/tmp/config",
        npm_config_prefix: "/tmp/npm",
      });
      expect(JSON.stringify(options.env)).not.toContain(CANARY);
      return 1;
    };
    expect(await ensureLocalTools(t.io, "codex")).toBe(false);
  });

  test("an accepted official script can repair herdr; the result reflects the new version", async () => {
    const t = terminal(
      {
        "herdr --version": ok("0.8.0"),
        "opencode --version": ok("1.2.0"),
        "opencode auth list": ok("● DeepSeek api\n└ 1 credentials"),
      },
      ["y"],
    );
    t.io.spawn = async (command, args) => {
      t.installs.push([command, args]);
      t.responses["herdr --version"] = ok("0.9.1");
      return 0;
    };
    expect(await ensureLocalTools(t.io, "deepseek")).toBe(true);
    expect(t.installs).toEqual([["sh", ["-c", "curl -fsSL https://herdr.dev/install.sh | sh"]]]);
  });
});

test("doctor selects only herdr profile harnesses, deduplicated", () => {
  expect(
    localHarnesses({
      conductor: {
        profiles: { cloud: { runtime: "conductor", agent: "codex" }, sub: { runtime: "claude-code", agent: "claude" } },
      },
      herdr: { profiles: { a: { harness: "codex" }, b: { harness: "codex" }, c: { harness: "deepseek" } } },
    }),
  ).toEqual(["codex", "deepseek"]);
  expect(localHarnesses({ conductor: { profiles: { cloud: { runtime: "conductor", agent: "claude" } } } })).toEqual([]);
});

test("doctor lists all configured gaps and JSON/read-only reports never offer installs", async () => {
  const config = { herdr: { profiles: { a: { harness: "codex" as const }, b: { harness: "deepseek" as const } } } };
  const t = terminal({}, ["yes", "yes", "yes"]);
  const checks = await localRuntimeChecks(t.io, config);
  expect(checks.map((check) => check.id)).toEqual(["local-herdr", "local-codex", "local-opencode", "local-dsh"]);
  const report = { schemaVersion: 1 as const, root: t.io.cwd, armadaVersion: "0.0.0", checks, errors: 3, warnings: 0 };
  expect(renderDoctor(report)).toContain("information only");
  expect(renderDoctor(report)).not.toContain("npm i -g @deepseek-ai/dsh");
  expect(renderDoctor(report)).toContain("3 errors");
  expect(t.prompts).toEqual([]);
  expect(t.installs).toEqual([]);
  await localRuntimeChecks(t.io, config, { readOnly: true });
  expect(t.prompts).toEqual([]);
  expect(await localRuntimeChecks(t.io, { conductor: {} })).toEqual([]);
});

test("doctor offers each gap separately and rechecks only the accepted install", async () => {
  const t = terminal({}, ["n", "y"]);
  t.io.spawn = async (command, args) => {
    t.installs.push([command, args]);
    t.responses["codex --version"] = ok("codex-cli 0.128.0");
    t.responses["codex login status"] = ok("");
    return 0;
  };
  const checks = await localRuntimeChecks(
    t.io,
    { herdr: { profiles: { a: { harness: "codex" } } } },
    { readOnly: false },
  );
  expect(t.prompts).toHaveLength(2);
  expect(t.installs).toEqual([["npm", ["i", "-g", "@openai/codex"]]]);
  expect(checks.find((check) => check.id === "local-herdr")?.level).toBe("error");
  expect(checks.find((check) => check.id === "local-codex")?.level).toBe("ok");
});

test("DeepSeek preflight distinguishes stored provider, missing provider, environment-only and unknown diagnostics", async () => {
  for (const [response, level] of [
    [ok("┌ Credentials /owner/auth.json\n│\n● DeepSeek api\n└ 1 credentials"), "ok"],
    [ok("● \u001b[32mDeepSeek\u001b[0m api\n└ 1 credentials"), "ok"],
    [ok("● OpenAI oauth\n└ 1 credentials"), "error"],
    [ok("└ 0 credentials\n┌ Environment\n● DeepSeek DEEPSEEK_API_KEY\n└ 1 environment variable"), "error"],
    [ok(`unexpected ${CANARY}`), "warning"],
    [ok(`● DeepSeek changed-schema\n└ 1 credentials`), "warning"],
    [{ code: 1, stdout: "", stderr: CANARY }, "warning"],
  ] as const) {
    const t = terminal({
      "herdr --version": ok("0.9.1"),
      "opencode --version": ok("1.2.0"),
      "opencode auth list": response,
    });
    const result = await detectLocalTools(t.io, ["deepseek"]);
    expect(result.checks.at(-1)?.level).toBe(level);
    expect(result.ready).toBe(level !== "error");
    expect(JSON.stringify(result)).not.toContain(CANARY);
    if (level !== "ok") expect(result.checks.at(-1)?.fix).toContain("`opencode`, then `/connect`");
    expect(t.calls).toEqual(["herdr --version", "opencode --version", "opencode auth list"]);
    expect(t.installs).toEqual([]);
  }
});

test("doctor's missing dsh is informational, never an install offer or plugin call", async () => {
  const t = terminal(
    {
      "herdr --version": ok("0.9.1"),
      "opencode --version": ok("1.2.0"),
      "opencode auth list": ok("● DeepSeek api\n└ 1 credentials"),
    },
    ["yes"],
  );
  const checks = await localRuntimeChecks(
    t.io,
    { herdr: { profiles: { deep: { harness: "deepseek" } } } },
    { readOnly: false },
  );
  expect(checks.every((check) => check.level === "ok")).toBe(true);
  expect(checks.at(-1)).toMatchObject({ id: "local-dsh", level: "ok", fix: null });
  expect(checks.at(-1)?.message).toContain("dsh is not installed; information only");
  expect(t.calls.filter((call) => call.startsWith("dsh"))).toEqual(["dsh --version"]);
  expect(t.prompts).toEqual([]);
  expect(t.installs).toEqual([]);
});

test("consented OpenCode install retains the DeepSeek-specific preflight", async () => {
  const t = terminal({ "herdr --version": ok("0.9.1") }, ["y"]);
  t.io.spawn = async (command, args) => {
    t.installs.push([command, args]);
    t.responses["opencode --version"] = ok("1.2.0");
    t.responses["opencode auth list"] = ok("● OpenAI oauth\n└ 1 credentials");
    return 0;
  };
  expect(await ensureLocalTools(t.io, "deepseek")).toBe(false);
  expect(t.installs).toEqual([["sh", ["-c", "curl -fsSL https://opencode.ai/install | bash"]]]);
  expect(t.output.join("")).toContain("/connect");
});
