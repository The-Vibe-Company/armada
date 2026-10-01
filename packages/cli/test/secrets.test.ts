import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenv } from "@armada/core";
import { ARMADA_URL, DEMO_TOML, fakeArmada, NOW } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Exec, Io, Spawn } from "../src/io.ts";
import { spawnInherited } from "../src/spawn.ts";

// Canary values: no output of Armada may ever contain one.
const OPENAI = "sk-CANARY-widgets-openai";
const SENTRY = "CANARY-org-sentry-dsn";
const GADGETS = "CANARY-gadgets-only";
const API_KEY = "armada_key_CANARY_coordinator";
const LAUNCH = "armada_launch_CANARY_1";
const NEW_VALUE = "sk-CANARY-new-value";
const CANARIES = [OPENAI, SENTRY, GADGETS, API_KEY, LAUNCH, NEW_VALUE];

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const realExec: Exec = async (command, args, { cwd }) => {
  const r = spawnSync(command, args, { cwd, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * A repository of widgets with a fake Armada keeping widgets', the
 * organization's and gadgets' secrets. `as: "coordinator"` signs in with an
 * organization API key; `as: "worker"` with the launch token of DEMO-7.
 */
async function setup(o: { as: "coordinator" | "worker"; env?: Record<string, string>; toml?: string }) {
  const home = await mkdtemp(join(tmpdir(), "armada-secrets-"));
  dirs.push(home);
  const armada = fakeArmada({
    keys: { [API_KEY]: "headless coordinator" },
    secrets: { widgets: { OPENAI_API_KEY: OPENAI }, "": { SENTRY_DSN: SENTRY }, gadgets: { GADGETS_ONLY: GADGETS } },
    vault: { linear: null, now: () => NOW },
  });
  armada.launches.set(LAUNCH, { project: "widgets", ticket: "DEMO-7", used: false });
  const out: string[] = [];
  const err: string[] = [];
  const spawned: { command: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  const spawn: Spawn = async (command, args, { env }) => {
    spawned.push({ command, args, env });
    return 3;
  };
  const io: Io = {
    cwd: home,
    env: {
      XDG_CONFIG_HOME: join(home, ".config"),
      ARMADA_API_URL: ARMADA_URL,
      ...(o.as === "coordinator" ? { ARMADA_API_KEY: API_KEY } : {}),
      ...o.env,
    },
    readFile: async (path) => (path === join(home, "armada.toml") ? (o.toml ?? DEMO_TOML) : null),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    fetch: armada.fetch,
    now: () => NOW,
    gitBranch: () => "feature/demo-7-do-the-thing",
    exec: realExec,
    spawn,
  };
  if (o.as === "worker") {
    expect(await run(["login", "--launch-token", LAUNCH], io)).toBe(0);
    out.splice(0);
  }
  return {
    io,
    home,
    armada,
    spawned,
    /** What was printed on stdout and stderr since the last call; asserts no canary leaked unless `allow`ed. */
    printed: (allow: string[] = []) => {
      const printed = { stdout: out.splice(0).join(""), stderr: err.splice(0).join("") };
      for (const canary of CANARIES.filter((c) => !allow.includes(c))) {
        expect(printed.stdout).not.toContain(canary);
        expect(printed.stderr).not.toContain(canary);
      }
      return printed;
    },
    /** The secrets calls Armada received, with how each was signed in. */
    asked: () =>
      armada.calls
        .filter((c) => c.path.startsWith("secrets/"))
        .map((c) => `${c.path} ${c.authorization ? "worker" : c.apiKey ? "api-key" : "none"}`),
  };
}

describe("armada run: one command with the project's secrets in its environment", () => {
  test("the child gets them, Armada's value over a variable of the same name; nothing is printed but the names", async () => {
    const s = await setup({ as: "worker", env: { OPENAI_API_KEY: "a stale local value", PATH: "/usr/bin" } });
    const code = await run(["run", "--", "bun", "test", "--watch", "-t", "x"], s.io);
    // The command's exit code is Armada's.
    expect(code).toBe(3);
    expect(s.spawned).toHaveLength(1);
    const child = s.spawned[0];
    expect([child?.command, child?.args]).toEqual(["bun", ["test", "--watch", "-t", "x"]]);
    expect(child?.env.OPENAI_API_KEY).toBe(OPENAI);
    expect(child?.env.SENTRY_DSN).toBe(SENTRY);
    expect(child?.env.PATH).toBe("/usr/bin");
    // Another project's secret never reaches it.
    expect(child?.env.GADGETS_ONLY).toBeUndefined();
    const { stdout, stderr } = s.printed();
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "! armada run: the project's OPENAI_API_KEY overrides the variable of the same name in this environment\n",
    );
    // Through the worker session: one release.
    expect(s.asked()).toEqual(["secrets/release worker"]);
  });

  test("--only hands out the names asked for and says which are not set", async () => {
    const s = await setup({ as: "coordinator" });
    expect(await run(["run", "--only", "SENTRY_DSN,NOT_SET", "--", "make", "test"], s.io)).toBe(3);
    expect(Object.keys(s.spawned[0]?.env ?? {}).filter((k) => /^[A-Z_]+$/.test(k) && k.endsWith("_DSN"))).toEqual([
      "SENTRY_DSN",
    ]);
    expect(s.spawned[0]?.env.OPENAI_API_KEY).toBeUndefined();
    expect(s.printed().stderr).toBe("! Not set for widgets: NOT_SET\n");
    expect(s.armada.calls.at(-1)?.body).toMatchObject({ names: ["SENTRY_DSN", "NOT_SET"] });
  });

  test("a real child process holds the secrets in its environment, and Armada's output holds none", async () => {
    const s = await setup({ as: "coordinator" });
    s.io.spawn = spawnInherited;
    // The child checks the value itself and answers with its exit code: nothing is printed.
    const check = `process.exit(process.env.OPENAI_API_KEY === ${JSON.stringify(OPENAI)} && process.env.SENTRY_DSN === ${JSON.stringify(SENTRY)} ? 7 : 1)`;
    expect(await run(["run", "--", process.execPath, "-e", check], s.io)).toBe(7);
    expect(s.printed()).toEqual({ stdout: "", stderr: "" });
    expect(await run(["run", "--", "armada-no-such-command-0859"], s.io)).toBe(1);
    expect(s.printed().stderr).toBe("armada: armada-no-such-command-0859: command not found\n");
  });

  test("without a command after --, or with -- on another command, it is a usage error", async () => {
    const s = await setup({ as: "coordinator" });
    expect(await run(["run"], s.io)).toBe(2);
    expect(s.printed().stderr).toContain("run needs a command after --");
    expect(await run(["status", "--", "x"], s.io)).toBe(2);
    expect(s.printed().stderr).toContain("-- does not apply to status");
  });
});

describe("a worker gets its own project's secrets only", () => {
  test("its worker session is refused in another project's repository, before anything is asked", async () => {
    const s = await setup({ as: "worker", toml: DEMO_TOML.replace('slug = "widgets"', 'slug = "gadgets"') });
    expect(await run(["run", "--", "make"], s.io)).toBe(2);
    expect(s.printed().stderr).toContain("the worker session of DEMO-7 is for the project widgets, not gadgets");
    expect(s.spawned).toHaveLength(0);
    expect(s.asked()).toEqual([]);
  });

  test("it sets nothing: Armada refuses a worker session", async () => {
    const s = await setup({ as: "worker", env: { NEW: NEW_VALUE } });
    expect(await run(["secrets", "set", "NEW_KEY", "--from-env", "NEW"], s.io)).toBe(1);
    expect(s.printed().stderr).toContain("a worker session sets no secret");
  });
});

describe("armada secrets: the coordinator sets, lists and unsets them; the value never on the command line", () => {
  test("from a hidden prompt, standard input or a variable of this environment", async () => {
    const s = await setup({ as: "coordinator", env: { FROM_HERE: NEW_VALUE } });
    const asked: { question: string; hidden: boolean }[] = [];
    s.io.interactive = true;
    s.io.prompt = async (question, { hidden }) => {
      asked.push({ question, hidden });
      return NEW_VALUE;
    };
    expect(await run(["secrets", "set", "PROMPTED"], s.io)).toBe(0);
    expect(asked).toEqual([{ question: "PROMPTED (hidden): ", hidden: true }]);
    s.io.readStdin = async () => `${NEW_VALUE}\n`;
    expect(await run(["secrets", "set", "PIPED", "--value-stdin"], s.io)).toBe(0);
    expect(await run(["secrets", "set", "MOVED", "--from-env", "FROM_HERE", "--org"], s.io)).toBe(0);
    expect(s.printed().stdout).toBe(
      [
        "Set PROMPTED for the project widgets. Workers get it on their next command.",
        "Set PIPED for the project widgets. Workers get it on their next command.",
        "Set MOVED for every project of the organization. Workers get it on their next command.",
        "",
      ].join("\n"),
    );
    expect(s.armada.secrets.get("widgets")?.get("PROMPTED")).toBe(NEW_VALUE);
    expect(s.armada.secrets.get("widgets")?.get("PIPED")).toBe(NEW_VALUE);
    expect(s.armada.secrets.get("")?.get("MOVED")).toBe(NEW_VALUE);
  });

  test("a value on the command line is refused without being quoted; without a terminal it says how", async () => {
    const s = await setup({ as: "coordinator" });
    expect(await run(["secrets", "set", "OPENAI_API_KEY", NEW_VALUE], s.io)).toBe(2);
    expect(s.printed().stderr).toContain("a value is never given on the command line");
    // A value typed where the name goes is not quoted either.
    expect(await run(["secrets", "set", NEW_VALUE], s.io)).toBe(2);
    expect(s.printed().stderr).toContain("a secret name is in upper snake case");
    expect(await run(["secrets", "set", "OPENAI_API_KEY"], s.io)).toBe(2);
    expect(s.printed().stderr).toContain("Next: --value-stdin to read it from standard input, or --from-env <VAR>");
    expect(await run(["secrets", "set", "X_KEY", "--from-env", "NOT_THERE"], s.io)).toBe(2);
    expect(s.printed().stderr).toContain("NOT_THERE is not set in this environment, so X_KEY was not set");
    expect(s.asked()).toEqual([]);
  });

  test("the list names each secret, where it is set, who set it and when; unset removes one", async () => {
    const s = await setup({ as: "coordinator" });
    s.armada.secrets.get("")?.set("OPENAI_API_KEY", "CANARY-org-openai");
    expect(await run(["secrets"], s.io)).toBe(0);
    expect(s.printed().stdout).toBe(
      [
        "Secrets for workers of widgets (names only; values stay in Armada)",
        "  OPENAI_API_KEY  project       set by Ada Example, 2026-03-05 10:00 UTC",
        "  OPENAI_API_KEY  organization  set by Ada Example, 2026-03-05 10:00 UTC (the project's own wins)",
        "  SENTRY_DSN      organization  set by Ada Example, 2026-03-05 10:00 UTC",
        "",
      ].join("\n"),
    );
    expect(await run(["secrets", "--json"], s.io)).toBe(0);
    expect(JSON.parse(s.printed().stdout).secrets.map((x: { name: string }) => x.name)).toEqual([
      "OPENAI_API_KEY",
      "OPENAI_API_KEY",
      "SENTRY_DSN",
    ]);
    expect(await run(["secrets", "unset", "OPENAI_API_KEY"], s.io)).toBe(0);
    expect(await run(["secrets", "unset", "OPENAI_API_KEY"], s.io)).toBe(0);
    expect(s.printed().stdout).toBe(
      "Unset OPENAI_API_KEY for the project widgets.\nOPENAI_API_KEY was not set for the project widgets: nothing changed.\n",
    );
  });

  test("get prints one value for a person, with a warning on stderr that it is now visible", async () => {
    const s = await setup({ as: "coordinator" });
    expect(await run(["secrets", "get", "OPENAI_API_KEY"], s.io)).toBe(0);
    const { stdout, stderr } = s.printed([OPENAI]);
    expect(stdout).toBe(`${OPENAI}\n`);
    expect(stderr).toContain("! The value of OPENAI_API_KEY is now visible in this terminal");
    expect(stderr).not.toContain(OPENAI);
    expect(await run(["secrets", "get", "NOT_SET"], s.io)).toBe(2);
    expect(s.printed().stderr).toContain("NOT_SET is not set for widgets");
  });
});

describe("armada secrets export: a dotenv file only its owner reads, and git ignores", () => {
  test("refused for a path git tracks or does not ignore; written 0600 where it ignores it", async () => {
    const s = await setup({ as: "worker" });
    const git = (...args: string[]) => spawnSync("git", args, { cwd: s.home, encoding: "utf8" });
    git("init", "--quiet");
    await writeFile(join(s.home, ".gitignore"), ".env.local\n.config/\n");
    await writeFile(join(s.home, "tracked.env"), "");
    git("add", "tracked.env", ".gitignore");

    expect(await run(["secrets", "export", "--file", "tracked.env"], s.io)).toBe(2);
    expect(s.printed().stderr).toContain(`git tracks ${join(s.home, "tracked.env")}`);
    expect(await run(["secrets", "export", "--file", "plain.env"], s.io)).toBe(2);
    expect(s.printed().stderr).toContain(`git does not ignore ${join(s.home, "plain.env")}`);
    expect(s.asked()).toEqual([]);

    // An existing file keeps no looser mode.
    await writeFile(join(s.home, ".env.local"), "OLD=1\n", { mode: 0o644 });
    expect(await run(["secrets", "export", "--file", ".env.local"], s.io)).toBe(0);
    expect(s.printed().stdout).toBe(
      "Wrote 2 secrets of widgets to .env.local (mode 0600): OPENAI_API_KEY, SENTRY_DSN.\n",
    );
    const path = join(s.home, ".env.local");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(parseDotenv(await readFile(path, "utf8")).values).toEqual({ OPENAI_API_KEY: OPENAI, SENTRY_DSN: SENTRY });
    expect(s.asked()).toEqual(["secrets/release worker"]);
  });
});
