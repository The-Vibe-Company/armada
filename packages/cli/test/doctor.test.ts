// `armada doctor`'s checks of this terminal: whether it is signed in to
// Armada (so its briefs give workers a launch token), whether keys left in the
// credentials file are no longer needed, whether this CLI is as recent as
// Armada expects, and whether the conductor command is found. A fake Armada
// answers.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check, ServerCli } from "@armada/core";
import { ARMADA_URL, type FakeVault, fakeArmada, NOW } from "../../core/test/support.ts";
import { version } from "../package.json" with { type: "json" };
import { run } from "../src/cli.ts";
import { BUNDLED_CONDUCTOR } from "../src/doctor.ts";
import type { Exec, Io } from "../src/io.ts";

// Canary secrets: no output may ever contain them.
const KEY = "armada_CANARY_coordinator_key";
const SESSION = "session-CANARY-1";
const LINEAR = "lin_api_CANARY_org_key";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const vault = (): FakeVault => ({
  linear: { apiKey: LINEAR, scope: "organization" },
  now: () => NOW,
});

/** A terminal in an empty directory, a credentials file holding `stored`, and a fake Armada. */
async function terminal(
  env: Record<string, string>,
  stored: Record<string, string> = {},
  v: FakeVault | null = null,
  more: { cli?: ServerCli; exec?: Exec; toml?: string } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "armada-doctor-"));
  dirs.push(home);
  const lines = Object.entries(stored).map(([k, value]) => `${k}=${value}\n`);
  if (lines.length) {
    await mkdir(join(home, "armada"), { mode: 0o700 });
    await writeFile(join(home, "armada", "credentials"), lines.join(""), { mode: 0o600 });
  }
  if (more.toml) await writeFile(join(home, "armada.toml"), more.toml);
  const armada = fakeArmada({
    keys: { [KEY]: "coordinator" },
    ...(v ? { vault: v } : {}),
    ...(more.cli ? { cli: more.cli } : {}),
  });
  const out: string[] = [];
  const io: Io = {
    cwd: home,
    env: { XDG_CONFIG_HOME: home, ARMADA_API_URL: ARMADA_URL, ...env },
    readFile: async () => null,
    stdout: (t) => out.push(t),
    stderr: (t) => out.push(t),
    ghToken: () => null,
    fetch: armada.fetch,
    now: () => NOW,
    ...(more.exec ? { exec: more.exec } : {}),
  };
  /** The sign-in, key-file, version and conductor checks of `armada doctor --json`. */
  const doctor = async () => {
    await run(["doctor", "--json"], io);
    const text = out.splice(0).join("");
    for (const secret of [KEY, SESSION, LINEAR]) expect(text).not.toContain(secret);
    const report = JSON.parse(text.slice(text.indexOf("{"))) as { checks: Check[] };
    return report.checks.filter((c) =>
      ["sign-in", "cli-version", "local-keys", "retired-keys", "conductor-cli"].includes(c.id),
    );
  };
  return { doctor, credentials: join(home, "armada", "credentials") };
}

describe("armada doctor: the sign-in to Armada", () => {
  test("not signed in, it warns that workers would need keys in their environment", async () => {
    const t = await terminal({});
    expect(await t.doctor()).toEqual([
      {
        id: "sign-in",
        level: "warning",
        message:
          "not signed in to Armada (armada.example.test): `armada brief` gives workers no launch token, so each worker needs the fleet's keys in its environment",
        fix: "`armada login`; a headless coordinator sets ARMADA_API_KEY to an organization API key",
      },
    ]);
  });

  test("signed in with an organization API key, it names the key and the organization", async () => {
    const t = await terminal({ ARMADA_API_KEY: KEY });
    expect(await t.doctor()).toEqual([
      {
        id: "sign-in",
        level: "ok",
        message: 'signed in to armada.example.test as the API key "coordinator" of Acme',
        fix: null,
      },
    ]);
  });

  test("a revoked sign-in is a warning with the way back", async () => {
    const t = await terminal({}, { ARMADA_SESSION_TOKEN: SESSION, ARMADA_SIGNED_IN_TO: ARMADA_URL });
    const [check] = await t.doctor();
    expect(check).toEqual({
      id: "sign-in",
      level: "warning",
      message:
        "the Armada sign-in of this terminal no longer works: the Armada sign-in of this terminal has expired or was revoked",
      fix: "`armada login`; a headless coordinator sets ARMADA_API_KEY to an organization API key",
    });
  });

  test("signed in to another Armada, it says which", async () => {
    const t = await terminal({}, { ARMADA_SESSION_TOKEN: SESSION, ARMADA_SIGNED_IN_TO: "https://armada.other.test" });
    expect((await t.doctor())[0]?.message).toBe(
      "this terminal is signed in to armada.other.test, not to armada.example.test (named by ARMADA_API_URL or [api] url)",
    );
  });

  test("a key left in the credentials file that Armada now gives is flagged; an environment override is not", async () => {
    const stored = { LINEAR_API_KEY: "lin_api_old" };
    const t = await terminal({ ARMADA_API_KEY: KEY }, stored, vault());
    expect((await t.doctor())[1]).toEqual({
      id: "local-keys",
      level: "warning",
      message: `${t.credentials} still holds LINEAR_API_KEY, which Armada now gives this terminal: it is no longer needed`,
      fix: "`armada auth logout` removes it from this machine; the sign-in to Armada stays",
    });

    // LINEAR_API_KEY from the environment is the override (CI, self-hosting): nothing is left over.
    const env = await terminal({ ARMADA_API_KEY: KEY, LINEAR_API_KEY: "lin_api_env" }, stored, vault());
    expect((await env.doctor()).map((c) => c.id)).toEqual(["sign-in"]);

    // An Armada that keeps no keys: the file's key is the one in use.
    const none = await terminal({ ARMADA_API_KEY: KEY }, stored);
    expect((await none.doctor()).map((c) => c.id)).toEqual(["sign-in"]);
  });

  test("database variables of earlier versions left in the credentials file are flagged, signed in or not, never shown", async () => {
    const stored = { ARMADA_TURSO_URL: "libsql://retired.example.test", ARMADA_TURSO_TOKEN: "retired-CANARY" };
    for (const env of [{}, { ARMADA_API_KEY: KEY }] as Record<string, string>[]) {
      const t = await terminal(env, stored);
      const retired = (await t.doctor()).find((c) => c.id === "retired-keys");
      expect(retired).toEqual({
        id: "retired-keys",
        level: "warning",
        message: `${t.credentials} still holds ARMADA_TURSO_URL, ARMADA_TURSO_TOKEN, which this version never reads: the CLI reaches the fleet's data through Armada`,
        fix: `\`armada login\` removes them as it signs this terminal in; or delete their lines from ${t.credentials}`,
      });
      expect(JSON.stringify(retired)).not.toContain("retired-CANARY");
    }
  });
});

describe("armada doctor: this CLI's version", () => {
  test("older than Armada expects, it is an error whose fix installs the latest; the sign-in is not checked twice", async () => {
    const t = await terminal({ ARMADA_API_KEY: KEY }, {}, vault(), { cli: { minimum: "99.0.0", latest: "99.1.0" } });
    expect(await t.doctor()).toEqual([
      {
        id: "cli-version",
        level: "error",
        message: `Armada ${version} is older than armada.example.test expects: it no longer reads its answers`,
        fix: "npm install -g @the-vibe-company/armada@99.1.0",
      },
    ]);
  });

  test("recent enough, it is ok and names a newer release", async () => {
    const t = await terminal({ ARMADA_API_KEY: KEY }, {}, null, { cli: { minimum: "0.0.1", latest: "99.1.0" } });
    expect((await t.doctor()).find((c) => c.id === "cli-version")).toEqual({
      id: "cli-version",
      level: "ok",
      message: `Armada ${version} is recent enough for armada.example.test (0.0.1 or newer); 99.1.0 is out: npm install -g @the-vibe-company/armada@99.1.0`,
      fix: null,
    });
  });
});

describe("armada doctor: the conductor command", () => {
  const TOML = `[project]
name = "Widgets"
slug = "widgets"

[tracker]
program_root = "DEMO-1"

[github]
repository = "acme/widgets"

[conductor.profiles.opus]
agent = "claude"
model = "opus"
effort = "high"
`;
  /** Runs `conductor` from the places in `found`; git is not there (the directory is the root). */
  const exec =
    (found: string[]): Exec =>
    async (command) => {
      if (!found.includes(command)) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
      return { code: 0, stdout: "0.89.2\n", stderr: "" };
    };
  const conductor = async (found: string[], env: Record<string, string> = {}, toml = TOML) => {
    const t = await terminal(env, {}, null, { exec: exec(found), toml });
    return (await t.doctor()).find((c) => c.id === "conductor-cli");
  };

  test("on PATH, it is ok; a project without Conductor profiles is not checked", async () => {
    expect(await conductor(["conductor"])).toEqual({
      id: "conductor-cli",
      level: "ok",
      message: "conductor 0.89.2 is on PATH",
      fix: null,
    });
    expect(await conductor([], {}, TOML.slice(0, TOML.indexOf("[conductor")))).toBeUndefined();
    // A conductor that refuses --version is there all the same.
    const refusing: Exec = async (command) => {
      if (command !== "conductor") throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
      return { code: 2, stdout: "", stderr: "unknown flag" };
    };
    const t = await terminal({}, {}, null, { exec: refusing, toml: TOML });
    expect((await t.doctor()).find((c) => c.id === "conductor-cli")?.message).toBe("conductor is on PATH");
  });

  test("only inside the macOS app, the fix links it from a directory on PATH, else adds it to PATH", async () => {
    const home = "/Users/ada";
    const linked = await conductor([BUNDLED_CONDUCTOR], { HOME: home, PATH: `/usr/bin:${home}/.local/bin` });
    expect(linked).toEqual({
      id: "conductor-cli",
      level: "warning",
      message: `conductor is not on PATH; the Conductor app ships it at ${BUNDLED_CONDUCTOR}`,
      fix: `ln -s "${BUNDLED_CONDUCTOR}" ~/.local/bin/conductor`,
    });
    expect((await conductor([BUNDLED_CONDUCTOR], { HOME: home, PATH: `${home}/bin/:/usr/bin` }))?.fix).toBe(
      `ln -s "${BUNDLED_CONDUCTOR}" ~/bin/conductor`,
    );
    expect((await conductor([BUNDLED_CONDUCTOR], { HOME: home, PATH: "/usr/bin" }))?.fix).toBe(
      'add `export PATH="/Applications/Conductor.app/Contents/Resources/bin:$PATH"` to your shell profile (~/.zshrc), or `sudo ln -s "/Applications/Conductor.app/Contents/Resources/bin/conductor" /usr/local/bin/conductor`',
    );
  });

  test("found nowhere, it says where it looked", async () => {
    expect(await conductor([])).toMatchObject({
      level: "warning",
      message: `conductor is not on PATH, nor at ${BUNDLED_CONDUCTOR}: the armada-runtime-conductor guide launches workers with it`,
    });
  });
});
