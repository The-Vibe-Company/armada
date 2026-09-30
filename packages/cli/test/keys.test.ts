import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLease } from "../../core/src/credentials.ts";
import type { Fetch } from "../../core/src/linear.ts";
import {
  ARMADA_URL,
  closeTempTurso,
  DEMO_TOML,
  type FakeVault,
  fakeArmada,
  NOW,
  recordedFetch,
  tempTurso,
} from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";

// Canary secrets: no output may ever contain them.
const SESSION = "CANARY_session_token";
const LINEAR = "lin_api_CANARY_org_key";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  await closeTempTurso();
});

/**
 * A machine with no local key: its config home is a temporary directory, and
 * its fetch reaches a fake Armada (with a vault) and recorded Linear and GitHub.
 */
async function machine(over: Partial<FakeVault> = {}, env: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "armada-keys-"));
  dirs.push(home);
  const { url } = await tempTurso();
  let clock = NOW.getTime();
  const vault: FakeVault = {
    linear: { apiKey: LINEAR, scope: "organization" },
    turso: "mint",
    tursoUrl: url,
    revision: "rev-1",
    now: () => new Date(clock),
    minted: 0,
    ...over,
  };
  const armada = fakeArmada({ token: SESSION, polls: ["approve"], vault });
  const linear = recordedFetch();
  let down = false;
  const fetch: Fetch = async (u, init) => {
    if (!u.startsWith(ARMADA_URL)) return linear.fetch(u, init);
    if (down) throw new TypeError("fetch failed");
    return armada.fetch(u, init);
  };
  const out: string[] = [];
  const io: Io = {
    cwd: "/work/widgets",
    env: { XDG_CONFIG_HOME: home, ARMADA_API_URL: ARMADA_URL, ...env },
    readFile: async (path) => (path === "/work/widgets/armada.toml" ? DEMO_TOML : null),
    stdout: (t) => out.push(t),
    stderr: (t) => out.push(t),
    ghToken: () => null,
    fetch,
    now: () => new Date(clock),
    sleep: async () => {},
    interactive: true,
  };
  const credentials = join(home, "armada", "credentials");
  return {
    io,
    vault,
    armada,
    linear,
    credentials,
    advance: (minutes: number) => {
      clock += minutes * 60_000;
    },
    armadaDown: (value: boolean) => {
      down = value;
    },
    lease: async () => parseLease((await readFile(credentials, "utf8")).match(/^ARMADA_TURSO_LEASE=(.*)$/m)?.[1]),
    asked: () => armada.calls.filter((c) => c.path === "credentials"),
    /** Everything printed since the last call; asserts no secret leaked. */
    printed: () => {
      const text = out.splice(0).join("");
      for (const secret of [SESSION, LINEAR, "minted-turso-token", "stored-db-token"])
        expect(text).not.toContain(secret);
      return text;
    },
  };
}

describe("the organization's keys from Armada", () => {
  test("on a machine with no local keys, armada login then armada status works with the organization's keys", async () => {
    const m = await machine();
    expect(await run(["status"], m.io)).toBe(2);
    expect(m.printed()).toContain("or sign in with `armada login`");

    expect(await run(["login"], m.io)).toBe(0);
    m.printed();
    expect(await run(["status", "--json"], m.io)).toBe(0);
    expect(JSON.parse(m.printed()).project.slug).toBe("widgets");
    // Linear was read with the organization's key.
    expect(m.linear.calls.find((c) => c.url.includes("linear"))?.authorization).toBe(LINEAR);

    // Only the short-lived Turso token is kept, with its expiry, in the 0600 file; never the Linear key.
    const file = await readFile(m.credentials, "utf8");
    expect(file).not.toContain(LINEAR);
    expect(await m.lease()).toMatchObject({
      api: ARMADA_URL,
      organization: "org-1",
      token: "minted-turso-token-1",
      expiresAt: "2026-03-04T14:00:00.000Z",
      revision: "rev-1",
    });
    expect((await stat(m.credentials)).mode & 0o777).toBe(0o600);

    expect(await run(["auth", "status"], m.io)).toBe(0);
    const status = m.printed();
    expect(status).toMatch(/LINEAR_API_KEY\s+set\s+Armada: the key of Acme/);
    expect(status).toMatch(
      /ARMADA_TURSO_TOKEN\s+set\s+Armada: a token made for this terminal, expires 2026-03-04 14:00 UTC/,
    );
  });

  test("the Turso token is kept while it lasts and renewed near its end, or as soon as the keys change, without asking", async () => {
    const m = await machine();
    expect(await run(["login"], m.io)).toBe(0);
    expect(await run(["auth", "status", "--json"], m.io)).toBe(0);
    m.printed();
    expect(m.vault.minted).toBe(1);

    // Armada is asked on every command, told which token the terminal holds (never the token), and says keep it.
    m.advance(60);
    expect(await run(["auth", "status", "--json"], m.io)).toBe(0);
    expect(m.asked().at(-1)?.body).toEqual({
      turso: { revision: "rev-1", expiresAt: "2026-03-04T14:00:00.000Z" },
    });
    expect(JSON.stringify(m.asked())).not.toContain("minted-turso-token");
    expect(m.vault.minted).toBe(1);

    // Less than an hour left: a new one, kept in place of the old.
    m.advance(2 * 60 + 30);
    expect(await run(["auth", "status", "--json"], m.io)).toBe(0);
    expect(m.vault.minted).toBe(2);
    expect((await m.lease())?.token).toBe("minted-turso-token-2");

    // A key replaced in the app takes effect on the next command.
    m.vault.revision = "rev-2";
    m.vault.linear = { apiKey: "lin_api_CANARY_own_key", scope: "own" };
    expect(await run(["auth", "status"], m.io)).toBe(0);
    expect(m.printed()).toMatch(/LINEAR_API_KEY\s+set\s+Armada: your own key/);
    expect((await m.lease())?.token).toBe("minted-turso-token-3");

    // Signing out drops the kept token with the sign-in.
    expect(await run(["logout"], m.io)).toBe(0);
    expect(await readFile(m.credentials, "utf8")).not.toContain("ARMADA_TURSO_LEASE");
  });

  test("Armada unreachable: a warning, then the machine's keys and the Turso token kept earlier while it lasts", async () => {
    const m = await machine();
    expect(await run(["login"], m.io)).toBe(0);
    expect(await run(["auth", "status"], m.io)).toBe(0);
    m.printed();
    await writeFile(m.credentials, `${await readFile(m.credentials, "utf8")}LINEAR_API_KEY=lin_api_local\n`);

    m.armadaDown(true);
    expect(await run(["auth", "status"], m.io)).toBe(0);
    const offline = m.printed();
    expect(offline).toContain("! Armada gave no keys (Armada (armada.example.test) unreachable");
    expect(offline).toMatch(/LINEAR_API_KEY\s+set\s+credentials file/);
    expect(offline).toMatch(/ARMADA_TURSO_TOKEN\s+set\s+Armada: a token made for this terminal/);

    // Signed out on Armada's side: the kept token is dropped at once.
    m.armadaDown(false);
    m.armada.sessions.clear();
    expect(await run(["auth", "status"], m.io)).toBe(0);
    const revoked = m.printed();
    expect(revoked).toContain("Next: armada login");
    expect(revoked).toMatch(/ARMADA_TURSO_TOKEN\s+missing/);
    expect(await readFile(m.credentials, "utf8")).not.toContain("ARMADA_TURSO_LEASE");
  });

  test("an expired kept token is not used, even with Armada unreachable", async () => {
    const m = await machine();
    expect(await run(["login"], m.io)).toBe(0);
    expect(await run(["auth", "status"], m.io)).toBe(0);
    m.printed();
    m.armadaDown(true);
    // Expired, the kept token is not used any more.
    m.advance(5 * 60);
    expect(await run(["auth", "status"], m.io)).toBe(0);
    expect(m.printed()).toMatch(/ARMADA_TURSO_TOKEN\s+missing/);
  });

  test("an Armada without a vault, or keys in the environment, leave the terminal as it was", async () => {
    const noVault = await machine({ off: true });
    expect(await run(["login"], noVault.io)).toBe(0);
    noVault.printed();
    expect(await run(["auth", "status"], noVault.io)).toBe(0);
    const quiet = noVault.printed();
    expect(quiet).not.toContain("!");
    expect(quiet).toMatch(/LINEAR_API_KEY\s+missing/);

    const env = { LINEAR_API_KEY: "lin_api_env", ARMADA_TURSO_URL: "file:env.db" };
    const configured = await machine({}, env);
    expect(await run(["login"], configured.io)).toBe(0);
    expect(await run(["auth", "status"], configured.io)).toBe(0);
    expect(configured.asked()).toEqual([]);
    expect(configured.printed()).toMatch(/LINEAR_API_KEY\s+set\s+environment \(LINEAR_API_KEY\)/);

    // A stored database token (no Turso Platform token on Armada) is used, and never written to the file.
    const stored = await machine({ turso: "stored" });
    expect(await run(["login"], stored.io)).toBe(0);
    expect(await run(["auth", "status"], stored.io)).toBe(0);
    expect(stored.printed()).toMatch(/ARMADA_TURSO_TOKEN\s+set\s+Armada: the stored Turso access of Acme/);
    expect(await readFile(stored.credentials, "utf8")).not.toContain("ARMADA_TURSO_LEASE");
  });
});
