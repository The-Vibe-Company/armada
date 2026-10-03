import { describe, expect, test } from "bun:test";
import { parseConfig } from "@armada/core";
import { DEMO_TOML } from "../../core/test/support.ts";
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

  test("checks each harness status and the exact DeepSeek model", async () => {
    const t = terminal({
      "herdr --version": ok("herdr 0.9.1"),
      "claude --version": ok("2.1.100 (Claude Code)"),
      "claude auth status": ok(JSON.stringify({ loggedIn: true, email: CANARY })),
      "codex --version": ok("codex-cli 0.128.0"),
      "codex login status": ok("", `Logged in using API key - ${CANARY}`),
      "opencode --version": ok("1.2.0"),
      "opencode models": ok("opencode/deepseek-v4-pro"),
    });
    const result = await detectLocalTools(
      t.io,
      ["claude", "codex", "opencode", "deepseek"],
      [
        { name: "general", harness: "opencode", model: "opencode/deepseek-v4-pro" },
        { name: "deep", harness: "deepseek", model: "opencode/deepseek-v4-pro" },
      ],
    );
    expect(result.ready).toBe(true);
    expect(result.checks.filter((check) => check.id.endsWith("-sign-in")).map((check) => check.level)).toEqual([
      "ok",
      "ok",
    ]);
    expect(result.checks.at(-1)?.message).toContain("OpenCode lists opencode/deepseek-v4-pro");
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

  test("unknown auth and diagnostic failures are not a false missing login", async () => {
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
        "opencode models": ok("opencode/deepseek-v4-pro"),
      },
      ["y"],
    );
    t.io.spawn = async (command, args) => {
      t.installs.push([command, args]);
      t.responses["herdr --version"] = ok("0.9.1");
      return 0;
    };
    expect(await ensureLocalTools(t.io, "deepseek", "opencode/deepseek-v4-pro")).toBe(true);
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
  expect(checks.map((check) => check.id)).toEqual([
    "local-herdr",
    "local-codex",
    "local-opencode",
    "local-opencode-effort",
    "local-dsh",
  ]);
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

test("DeepSeek preflight checks exact model IDs across providers without auth or keys", async () => {
  for (const model of ["opencode/deepseek-v4-pro", "openrouter/deepseek/deepseek-chat", "deepseek/deepseek-reasoner"]) {
    for (const [response, ready] of [
      [ok(`${model}\nopencode/deepseek-v4-flash`), true],
      [ok(`\u001b[32m${model}\u001b[0m\n`), true],
      [ok(`${model}-other\nother/${model}`), false],
      [ok("opencode/deepseek-v4-flash"), false],
      [ok(`unexpected ${CANARY}`), false],
      [{ code: 1, stdout: model, stderr: CANARY }, false],
      [new Error(CANARY), false],
    ] as const) {
      const t = terminal({
        "herdr --version": ok("0.9.1"),
        "opencode --version": ok("1.2.0"),
        "opencode models": response,
      });
      const result = await detectLocalTools(t.io, ["deepseek"], [model]);
      expect(result.ready).toBe(ready);
      expect(result.checks.at(-1)?.level).toBe(ready ? "ok" : "error");
      expect(JSON.stringify(result)).not.toContain(CANARY);
      if (!ready) {
        expect(result.checks.at(-1)?.fix).toContain("`opencode`, then `/connect`");
        expect(result.checks.at(-1)?.fix).toContain("`opencode models`");
      }
      expect(t.calls).toEqual(["herdr --version", "opencode --version", "opencode models"]);
      expect(t.installs).toEqual([]);
    }
  }
});

test("doctor checks every distinct DeepSeek profile model with one read-only models call", async () => {
  const t = terminal({
    "herdr --version": ok("0.9.1"),
    "opencode --version": ok("1.2.0"),
    "opencode models": ok("opencode/deepseek-v4-pro\nopenrouter/deepseek/deepseek-chat"),
  });
  const checks = await localRuntimeChecks(t.io, {
    herdr: {
      profiles: {
        zen: { harness: "deepseek", model: "opencode/deepseek-v4-pro#high" },
        duplicate: { harness: "deepseek", model: "opencode/deepseek-v4-pro" },
        router: { harness: "deepseek", model: "openrouter/deepseek/deepseek-chat" },
        absent: { harness: "deepseek", model: "opencode/deepseek-v4-flash" },
      },
    },
  });
  expect(checks.filter((check) => check.id.startsWith("local-opencode-deepseek:")).map((check) => check.level)).toEqual(
    ["error", "ok", "ok", "error"],
  );
  expect(t.calls.filter((call) => call === "opencode models")).toHaveLength(1);
  expect(t.calls.some((call) => call.includes("auth"))).toBe(false);
});

test("doctor's missing dsh is informational, never an install offer or plugin call", async () => {
  const t = terminal(
    {
      "herdr --version": ok("0.9.1"),
      "opencode --version": ok("1.2.0"),
      "opencode models": ok("opencode/deepseek-v4-pro"),
    },
    ["yes"],
  );
  const checks = await localRuntimeChecks(
    t.io,
    { herdr: { profiles: { deep: { harness: "deepseek", model: "opencode/deepseek-v4-pro" } } } },
    { readOnly: false },
  );
  expect(checks.filter((check) => check.id !== "local-opencode-effort").every((check) => check.level === "ok")).toBe(
    true,
  );
  expect(checks.find((check) => check.id === "local-opencode-effort")).toMatchObject({
    level: "warning",
    message: expect.stringContaining("effort is not applied for OpenCode"),
  });
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
    t.responses["opencode models"] = ok("opencode/deepseek-v4-flash");
    return 0;
  };
  expect(await ensureLocalTools(t.io, "deepseek", "opencode/deepseek-v4-pro")).toBe(false);
  expect(t.installs).toEqual([["sh", ["-c", "curl -fsSL https://opencode.ai/install | bash"]]]);
  expect(t.output.join("")).toContain("/connect");
});

const selectionConfig = (harness: "opencode" | "deepseek", line: string) => `${DEMO_TOML}
# Keep this comment and all existing formatting.
[herdr.profiles.worker] # owner profile
harness = "${harness}"
${line}effort = "high" # keep the effort
[herdr.profiles.other]
harness = "codex"
model = "other-model" # untouched
effort = "high"
`;
const listedModels = "opencode/deepseek-v4.1-flash\nopenrouter/deepseek/deepseek-chat\nopenai/model-a\n";
function modelTerminal(harness: "opencode" | "deepseek", line: string, answer: string | null = "1") {
  const t = terminal(
    {
      "herdr --version": ok("0.9.1"),
      "opencode --version": ok("1.2.0"),
      "opencode models": ok(listedModels),
      "codex --version": ok("0.128.0"),
      "codex login status": ok(""),
    },
    [answer],
  );
  t.io.codexModels = async () => ["other-model"];
  let text = selectionConfig(harness, line);
  const writes: [string, string][] = [];
  t.io.readFile = async () => text;
  t.io.writeFile = async (path, next) => {
    writes.push([path, next]);
    text = next;
  };
  return { ...t, writes, text: () => text };
}

test("doctor asks and saves a missing or unavailable OpenCode model, preserving comments and other profiles", async () => {
  for (const harness of ["opencode", "deepseek"] as const) {
    for (const line of ["", '  model = "opencode/deepseek-old"  # keep model comment\n']) {
      const t = modelTerminal(harness, line, harness === "deepseek" ? "2" : "3");
      const original = t.text();
      const checks = await localRuntimeChecks(t.io, parseConfig(original), { readOnly: false });
      const chosen = harness === "deepseek" ? "openrouter/deepseek/deepseek-chat" : "openai/model-a";
      expect(t.writes).toHaveLength(1);
      expect(t.writes[0]?.[0]).toBe("/work/widgets/armada.toml");
      expect(parseConfig(t.text()).herdr.profiles.worker?.model).toBe(chosen);
      expect(t.text()).toBe(
        line
          ? original.replace('"opencode/deepseek-old"', JSON.stringify(chosen))
          : original.replace(
              "[herdr.profiles.worker] # owner profile\n",
              `[herdr.profiles.worker] # owner profile\nmodel = ${JSON.stringify(chosen)}\n`,
            ),
      );
      expect(t.output.join("")).toContain(`Wrote model = ${JSON.stringify(chosen)}`);
      expect(
        checks.filter((check) => check.id !== "local-opencode-effort").every((check) => check.level === "ok"),
      ).toBe(true);
      expect(checks.find((check) => check.id === "local-opencode-effort")).toMatchObject({
        level: "warning",
        message: expect.stringContaining("effort is not applied for OpenCode"),
      });
      expect(t.output.join("").includes("3. openai/model-a")).toBe(harness === "opencode");
      expect(t.calls.some((call) => call.includes("auth"))).toBe(false);
    }
  }
});

test("model selection without TTY, in JSON/read-only or CI prints choices and config line without a write", async () => {
  for (const mode of ["non-tty", "json", "ci"]) {
    const t = modelTerminal("deepseek", "");
    if (mode === "non-tty") t.io.interactive = false;
    if (mode === "ci") t.io.env.CI = "true";
    const checks = await localRuntimeChecks(t.io, parseConfig(t.text()), { readOnly: mode === "json" });
    expect(t.writes).toEqual([]);
    expect(t.prompts).toEqual([]);
    const report = renderDoctor({
      schemaVersion: 1,
      root: t.io.cwd,
      armadaVersion: "0.0.0",
      checks,
      errors: 1,
      warnings: 0,
    });
    expect(report).toContain("1. opencode/deepseek-v4.1-flash");
    expect(report).not.toContain("openai/model-a");
    expect(report).toContain('model = "<exact model id>"');
    expect(report).toContain("[herdr.profiles.worker]");
  }
});

test("cancelled, empty, invalid and failed model writes leave configuration and readiness unchanged", async () => {
  for (const answer of [null, "", "0", "999", "text", "1"]) {
    const t = modelTerminal("deepseek", "", answer);
    const original = t.text();
    if (answer === "1")
      t.io.writeFile = async () => {
        throw new Error(CANARY);
      };
    const checks = await localRuntimeChecks(t.io, parseConfig(original), { readOnly: false });
    expect(t.writes).toEqual([]);
    expect(t.text()).toBe(original);
    expect(checks.some((check) => check.level === "error")).toBe(true);
    expect(t.output.join("")).not.toContain(CANARY);
  }
});

test("a present non-DeepSeek model and a variant suffix cannot satisfy an exact DeepSeek selection", async () => {
  const t = terminal({
    "herdr --version": ok("0.9.1"),
    "opencode --version": ok("1.2.0"),
    "opencode models": ok("openai/model-a\nopencode/deepseek-v4.1-flash"),
  });
  for (const model of ["openai/model-a", "opencode/deepseek-v4.1-flash#high"]) {
    expect((await detectLocalTools(t.io, ["deepseek"], [model])).ready).toBe(false);
  }
});

test("a config edit while choosing a model is preserved and prevents a stale write", async () => {
  const t = modelTerminal("deepseek", "");
  const original = t.text();
  let external = original;
  t.io.readFile = async () => external;
  t.io.prompt = async () => {
    external = `${original}# concurrent owner edit\n`;
    return "1";
  };
  const checks = await localRuntimeChecks(t.io, parseConfig(original), { readOnly: false });
  expect(t.writes).toEqual([]);
  expect(external).toContain("# concurrent owner edit");
  expect(checks.some((check) => check.level === "error")).toBe(true);
});

test("model choice preserves CRLF, quoted section names and literal-string quoting", async () => {
  const t = modelTerminal("deepseek", "model = 'opencode/deepseek-old' # model note\n");
  const original = t.text().replace("[herdr.profiles.worker]", '[herdr.profiles."worker"]').replaceAll("\n", "\r\n");
  let text = original;
  t.io.readFile = async () => text;
  t.io.writeFile = async (_path, next) => {
    text = next;
  };
  const checks = await localRuntimeChecks(t.io, parseConfig(original), { readOnly: false });
  expect(text).toBe(original.replace("'opencode/deepseek-old'", "'opencode/deepseek-v4.1-flash'"));
  expect(checks.filter((check) => check.id !== "local-opencode-effort").every((check) => check.level === "ok")).toBe(
    true,
  );
  expect(checks.find((check) => check.id === "local-opencode-effort")).toMatchObject({
    level: "warning",
    message: expect.stringContaining("effort is not applied for OpenCode"),
  });
});

test("the shared OpenCode preflight validates the supplied exact model without credentials", async () => {
  const t = terminal({
    "herdr --version": ok("0.9.1"),
    "opencode --version": ok("1.2.0"),
    "opencode models": ok("openai/model-a\nopencode/deepseek-v4.1-flash"),
  });
  expect(await ensureLocalTools(t.io, "opencode", "openai/model-a")).toBe(true);
  expect(await ensureLocalTools(t.io, "deepseek", "opencode/deepseek-v4.1-flash#high")).toBe(false);
  expect(t.calls.some((call) => call.includes("auth"))).toBe(false);
});

test("doctor verifies Claude help examples without treating them as a complete catalog", async () => {
  const t = terminal({
    "herdr --version": ok("0.9.1"),
    "claude --version": ok("2.1.266"),
    "claude auth status": ok('{"loggedIn":true}'),
    "claude --help": ok(
      "Options:\n  --model <model> Model for the session. Provide an alias\n    (e.g. 'sonnet' or 'opus') or a full name (e.g. 'claude-sonnet-4-6').\n  --other <value> ignored\n",
    ),
  });
  const checks = await localRuntimeChecks(t.io, {
    herdr: {
      profiles: {
        old: { harness: "claude", model: "claude-opus-5-5" },
        alias: { harness: "claude", model: "opus" },
        example: { harness: "claude", model: "claude-sonnet-4-6" },
      },
    },
  });
  expect(checks.find((c) => c.id === "local-claude-model:old")).toMatchObject({ level: "error" });
  expect(checks.find((c) => c.id === "local-claude-model:old")?.fix).toContain('model = "opus"');
  expect(checks.find((c) => c.id === "local-claude-model:old")?.fix).toContain("claude update");
  expect(checks.find((c) => c.id === "local-claude-model:alias")?.level).toBe("ok");
  expect(checks.find((c) => c.id === "local-claude-model:example")?.level).toBe("ok");
  expect(t.calls.filter((c) => c === "claude --help")).toHaveLength(1);
  expect(t.prompts).toEqual([]);
});

test("doctor flags a Codex model absent for this sign-in and keeps harness catalogs separate", async () => {
  const t = terminal({
    "herdr --version": ok("0.9.1"),
    "codex --version": ok("0.128.0"),
    "codex login status": ok("", `Logged in using ChatGPT ${CANARY}`),
    "opencode --version": ok("1.2.0"),
    "opencode models": ok("openai/gpt-example\n"),
  });
  let catalogs = 0;
  t.io.codexModels = async () => {
    catalogs++;
    return ["gpt-example"];
  };
  const checks = await localRuntimeChecks(t.io, {
    herdr: {
      profiles: {
        unavailable: { harness: "codex", model: "gpt-6.1-sol" },
        available: { harness: "codex", model: "gpt-example" },
        wrongHarness: { harness: "codex", model: "openai/gpt-example" },
        open: { harness: "opencode", model: "openai/gpt-example" },
      },
    },
  });
  const missing = checks.find((c) => c.id === "local-codex-model:unavailable");
  expect(missing?.level).toBe("error");
  expect(missing?.message).toContain("for this sign-in");
  expect(missing?.fix).toContain("codex login --with-api-key");
  expect(missing?.fix).toContain("the owner");
  expect(checks.find((c) => c.id === "local-codex-model:available")?.level).toBe("ok");
  expect(checks.find((c) => c.id === "local-codex-model:wrongHarness")?.level).toBe("error");
  expect(checks.find((c) => c.id === "local-opencode-opencode:open")?.level).toBe("ok");
  expect(catalogs).toBe(1);
  expect(JSON.stringify(checks)).not.toContain(CANARY);
});

test("doctor saves only a numbered Codex catalog pick; read-only modes and failures never write", async () => {
  for (const mode of ["interactive", "json", "ci", "non-tty", "unavailable", "throws"] as const) {
    const t = terminal(
      {
        "herdr --version": ok("0.9.1"),
        "codex --version": ok("0.128.0"),
        "codex login status": ok(""),
      },
      ["2"],
    );
    let text = `${DEMO_TOML}\n[herdr.profiles.worker]\nharness = "codex"\nmodel = "gpt-missing" # keep\neffort = "high"\n`;
    const original = text;
    t.io.codexModels = async () => {
      if (mode === "throws") throw new Error(CANARY);
      return mode === "unavailable" ? null : ["gpt-example", "gpt-other"];
    };
    t.io.readFile = async () => text;
    t.io.writeFile = async (_path, next) => {
      text = next;
    };
    if (mode === "ci") t.io.env.CI = "true";
    if (mode === "non-tty") t.io.interactive = false;
    const checks = await localRuntimeChecks(t.io, parseConfig(text), { readOnly: mode === "json" });
    expect(text).toBe(mode === "interactive" ? original.replace('"gpt-missing"', '"gpt-other"') : original);
    expect(checks.some((c) => c.level === "error")).toBe(mode !== "interactive");
    expect(t.output.join("")).not.toContain(CANARY);
    expect(t.installs).toEqual([]);
  }
});

test("doctor bounds the Claude help probe and never reads a Codex catalog after known missing sign-in", async () => {
  const t = terminal({
    "herdr --version": ok("0.9.1"),
    "claude --version": ok("2.1.266"),
    "claude auth status": ok('{"loggedIn":true}'),
    "claude --help": { code: 1, stdout: "", stderr: CANARY },
    "codex --version": ok("0.128.0"),
    "codex login status": { code: 1, stdout: "Not logged in", stderr: "" },
  });
  const exec = t.io.exec;
  if (!exec) throw new Error("fixture requires exec");
  let helpOptions: { timeoutMs?: number; maxOutputBytes?: number } = {};
  t.io.exec = async (command, args, options) => {
    if (command === "claude" && args[0] === "--help") helpOptions = options;
    return exec(command, args, options);
  };
  let catalogs = 0;
  t.io.codexModels = async () => {
    catalogs++;
    return ["gpt-example"];
  };
  const checks = await localRuntimeChecks(t.io, {
    herdr: {
      profiles: {
        claude: { harness: "claude", model: "opus" },
        codex: { harness: "codex", model: "gpt-example" },
      },
    },
  });
  expect(helpOptions).toMatchObject({ timeoutMs: 5_000, maxOutputBytes: 262_144 });
  expect(catalogs).toBe(0);
  expect(checks.find((c) => c.id === "local-claude-model:claude")?.level).toBe("error");
  expect(checks.find((c) => c.id === "local-codex-sign-in")?.level).toBe("error");
  expect(JSON.stringify(checks)).not.toContain(CANARY);
});
