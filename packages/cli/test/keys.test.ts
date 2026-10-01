import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerCli } from "../../core/src/armada-api.ts";
import type { Fetch } from "../../core/src/linear.ts";
import { ARMADA_URL, DEMO_TOML, type FakeVault, fakeArmada, NOW, recordedFetch } from "../../core/test/support.ts";
import { version } from "../package.json" with { type: "json" };
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";

// Canary secrets: no output may ever contain them.
const SESSION = "CANARY_session_token";
const LINEAR = "lin_api_CANARY_org_key";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * A machine with no local key: its config home is a temporary directory, and
 * its fetch reaches a fake Armada (with a vault) and recorded Linear and GitHub.
 */
async function machine(over: Partial<FakeVault> = {}, env: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "armada-keys-"));
  dirs.push(home);
  const vault: FakeVault = {
    linear: { apiKey: LINEAR, scope: "organization" },
    now: () => NOW,
    ...over,
  };
  let cli: ServerCli | undefined;
  const armada = fakeArmada({
    token: SESSION,
    polls: ["approve"],
    vault,
    get cli() {
      return cli;
    },
  });
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
    now: () => NOW,
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
    armadaDown: (value: boolean) => {
      down = value;
    },
    /** What Armada says of the CLIs it serves, from now on. */
    serverCli: (value: ServerCli) => {
      cli = value;
    },
    asked: () => armada.calls.filter((c) => c.path === "credentials"),
    /** Everything printed since the last call; asserts no secret leaked. */
    printed: () => {
      const text = out.splice(0).join("");
      for (const secret of [SESSION, LINEAR, "CANARY"]) expect(text).not.toContain(secret);
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
    // Linear was read with the organization's key, asked for with the session and nothing else.
    expect(m.linear.calls.find((c) => c.url.includes("linear"))?.authorization).toBe(LINEAR);
    expect(m.asked().map((c) => [c.authorization, c.body])).toEqual([[`Bearer ${SESSION}`, {}]]);

    // The Linear key stays in memory: the 0600 file holds the sign-in only.
    const file = await readFile(m.credentials, "utf8");
    expect(file).not.toContain(LINEAR);
    expect(file).not.toContain("TURSO");
    expect((await stat(m.credentials)).mode & 0o777).toBe(0o600);

    expect(await run(["auth", "status"], m.io)).toBe(0);
    expect(m.printed()).toMatch(/LINEAR_API_KEY\s+set\s+Armada: the key of Acme/);
  });

  test("Armada is asked on every command: a key replaced in the app takes effect on the next one, with its warnings", async () => {
    const m = await machine();
    expect(await run(["login"], m.io)).toBe(0);
    expect(await run(["auth", "status"], m.io)).toBe(0);
    expect(m.printed()).toMatch(/LINEAR_API_KEY\s+set\s+Armada: the key of Acme/);

    m.vault.linear = { apiKey: "lin_api_CANARY_own_key", scope: "own" };
    m.vault.warnings = ["your own Linear key was last checked a week ago"];
    expect(await run(["auth", "status"], m.io)).toBe(0);
    const text = m.printed();
    expect(text).toMatch(/LINEAR_API_KEY\s+set\s+Armada: your own key/);
    expect(text).toContain("! Armada: your own Linear key was last checked a week ago\n");
    expect(m.asked()).toHaveLength(2);
  });

  test("Armada unreachable, or the sign-in revoked: a warning, then the machine's keys", async () => {
    const m = await machine();
    expect(await run(["login"], m.io)).toBe(0);
    m.printed();
    await writeFile(m.credentials, `${await readFile(m.credentials, "utf8")}LINEAR_API_KEY=lin_api_local\n`);

    m.armadaDown(true);
    expect(await run(["auth", "status"], m.io)).toBe(0);
    const offline = m.printed();
    expect(offline).toContain("! Armada gave no keys (Armada (armada.example.test) unreachable");
    expect(offline).toMatch(/LINEAR_API_KEY\s+set\s+credentials file/);

    m.armadaDown(false);
    m.armada.sessions.clear();
    expect(await run(["auth", "status"], m.io)).toBe(0);
    const revoked = m.printed();
    expect(revoked).toContain("Next: armada login");
    expect(revoked).toMatch(/LINEAR_API_KEY\s+set\s+credentials file/);
  });

  test("a CLI older than Armada expects stops on one line that upgrades it, whatever keys the machine has", async () => {
    const m = await machine();
    expect(await run(["login"], m.io)).toBe(0);
    m.printed();
    await writeFile(m.credentials, `${await readFile(m.credentials, "utf8")}LINEAR_API_KEY=lin_api_local\n`);
    m.serverCli({ minimum: "99.0.0", latest: "99.1.0" });
    expect(await run(["status"], m.io)).toBe(1);
    expect(m.printed()).toBe(
      `armada: Armada ${version} is older than this server expects: npm install -g @the-vibe-company/armada@99.1.0\n`,
    );
    expect(m.asked().at(-1)?.version).toBe(version);
  });

  test("an Armada without a vault, or keys in the environment, leave the terminal as it was", async () => {
    const noVault = await machine({ off: true });
    expect(await run(["login"], noVault.io)).toBe(0);
    noVault.printed();
    expect(await run(["auth", "status"], noVault.io)).toBe(0);
    const quiet = noVault.printed();
    expect(quiet).not.toContain("!");
    expect(quiet).toMatch(/LINEAR_API_KEY\s+missing/);

    const configured = await machine({}, { LINEAR_API_KEY: "lin_api_env" });
    expect(await run(["login"], configured.io)).toBe(0);
    expect(await run(["auth", "status"], configured.io)).toBe(0);
    expect(configured.asked()).toEqual([]);
    expect(configured.printed()).toMatch(/LINEAR_API_KEY\s+set\s+environment \(LINEAR_API_KEY\)/);
  });

  test("a worker session of another project is refused before any key is asked or anything is written", async () => {
    const m = await machine();
    m.armada.launches.set("armada_launch_CANARY_9", { project: "gadgets", ticket: "DEMO-7", used: false });
    expect(await run(["login", "--launch-token", "armada_launch_CANARY_9", "--api-url", ARMADA_URL], m.io)).toBe(0);
    m.printed();
    expect(await run(["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws/s"], m.io)).toBe(2);
    expect(m.printed()).toBe(
      "armada: the worker session of DEMO-7 is for the project gadgets, not widgets (armada.toml): this repository is not its own\nNext: cd into the repository of gadgets\n",
    );
    expect(m.asked()).toEqual([]);
    expect(m.armada.calls.filter((c) => c.path.startsWith("fleet/"))).toEqual([]);
  });
});

describe("keys of the retired fleet database", () => {
  test("armada login removes ARMADA_TURSO_URL, ARMADA_TURSO_TOKEN and ARMADA_TURSO_LEASE, without printing them", async () => {
    const m = await machine();
    await mkdir(dirname(m.credentials), { recursive: true });
    await writeFile(
      m.credentials,
      "# mine\nOTHER_TOOL=keep\nARMADA_TURSO_URL=libsql://CANARY-db.example.io\nARMADA_TURSO_TOKEN=CANARY_db_token\nARMADA_TURSO_LEASE=CANARY_lease\n",
      { mode: 0o600 },
    );
    expect(await run(["login"], m.io)).toBe(0);
    m.printed();
    const file = await readFile(m.credentials, "utf8");
    expect(file).not.toContain("TURSO");
    expect(file).toStartWith("# mine\nOTHER_TOOL=keep\n");
    expect(file).toContain(`ARMADA_SESSION_TOKEN=${SESSION}\n`);
  });
});
