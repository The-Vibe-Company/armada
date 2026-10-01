// `armada doctor`'s sign-in checks: whether this terminal is signed in to
// Armada (so its briefs give workers a launch token), and whether keys left
// in the credentials file are no longer needed. A fake Armada answers.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check } from "@armada/core";
import { ARMADA_URL, type FakeVault, fakeArmada, NOW } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";

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
async function terminal(env: Record<string, string>, stored: Record<string, string> = {}, v: FakeVault | null = null) {
  const home = await mkdtemp(join(tmpdir(), "armada-doctor-"));
  dirs.push(home);
  const lines = Object.entries(stored).map(([k, value]) => `${k}=${value}\n`);
  if (lines.length) {
    await mkdir(join(home, "armada"), { mode: 0o700 });
    await writeFile(join(home, "armada", "credentials"), lines.join(""), { mode: 0o600 });
  }
  const armada = fakeArmada({ keys: { [KEY]: "coordinator" }, ...(v ? { vault: v } : {}) });
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
  };
  /** The sign-in and key-file checks of `armada doctor --json`. */
  const doctor = async () => {
    await run(["doctor", "--json"], io);
    const text = out.splice(0).join("");
    for (const secret of [KEY, SESSION, LINEAR]) expect(text).not.toContain(secret);
    const report = JSON.parse(text.slice(text.indexOf("{"))) as { checks: Check[] };
    return report.checks.filter((c) => ["sign-in", "local-keys", "retired-keys"].includes(c.id));
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
    for (const env of [{}, { ARMADA_API_KEY: KEY }]) {
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
