import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEMO_TOML, NOW, recordedFetch } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";
import { echo, emptyLine, feedLine } from "../src/line.ts";

// Canary value: no output may ever contain it.
const LINEAR = "lin_api_CANARY_linear";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A machine whose config home is a fresh temporary directory; never the real one. */
async function machine(env: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "armada-auth-"));
  dirs.push(home);
  const out: string[] = [];
  const err: string[] = [];
  const asked: { question: string; hidden: boolean }[] = [];
  const answers: Record<string, string | null> = {};
  const recorded = recordedFetch();
  const io: Io = {
    cwd: "/work/widgets",
    env: { XDG_CONFIG_HOME: home, ...env },
    readFile: async (path) => (path === "/work/widgets/armada.toml" ? DEMO_TOML : null),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    fetch: recorded.fetch,
    now: () => NOW,
    interactive: true,
    prompt: async (question, { hidden }) => {
      asked.push({ question, hidden });
      const variable = question.split(/[ :]/)[0] ?? "";
      return Object.hasOwn(answers, variable) ? (answers[variable] ?? null) : "";
    },
  };
  const dir = join(home, "armada");
  const output = () => out.join("") + err.join("");
  return {
    io,
    answers,
    asked,
    calls: recorded.calls,
    credentials: join(dir, "credentials"),
    config: join(dir, "config.toml"),
    out: () => out.join(""),
    err: () => err.join(""),
    /** Everything printed so far; asserts no canary leaked. */
    printed: () => {
      const text = output();
      expect(text).not.toContain(LINEAR);
      return text;
    },
    reset: () => {
      out.length = 0;
      err.length = 0;
      asked.length = 0;
    },
  };
}

describe("armada auth login", () => {
  test("asks only for the missing Linear key, hidden, stores it 0600, and asks nothing the second time", async () => {
    const m = await machine();
    m.answers.LINEAR_API_KEY = LINEAR;

    expect(await run(["auth", "login"], m.io)).toBe(0);
    expect(m.asked.map((a) => [a.question.split(/[ :]/)[0], a.hidden])).toEqual([["LINEAR_API_KEY", true]]);
    expect(await readFile(m.credentials, "utf8")).toBe(`LINEAR_API_KEY=${LINEAR}\n`);
    expect((await stat(m.credentials)).mode & 0o777).toBe(0o600);
    expect((await stat(m.config)).isFile()).toBe(true);
    expect(m.printed()).toContain("Saved LINEAR_API_KEY in");

    m.reset();
    expect(await run(["auth", "login"], m.io)).toBe(0);
    expect(m.asked).toEqual([]);
    expect(m.printed()).toContain("Every Armada key is already set");
  });

  test("a key set in the environment is not asked, and the file keeps its other lines", async () => {
    const env = await machine({ LINEAR_API_KEY: LINEAR });
    expect(await run(["auth", "login"], env.io)).toBe(0);
    expect(env.asked).toEqual([]);
    expect(env.printed()).toContain("Every Armada key is already set");
    expect(await stat(env.credentials).catch(() => null)).toBeNull();

    const m = await machine();
    await mkdir(dirname(m.credentials), { recursive: true });
    await writeFile(m.credentials, "# written by hand\nOTHER_TOOL=keep\n");
    m.answers.LINEAR_API_KEY = LINEAR;
    expect(await run(["auth", "login"], m.io)).toBe(0);
    expect(m.asked.map((a) => a.question.split(/[ :]/)[0])).toEqual(["LINEAR_API_KEY"]);
    expect(await readFile(m.credentials, "utf8")).toBe(
      `# written by hand\nOTHER_TOOL=keep\nLINEAR_API_KEY=${LINEAR}\n`,
    );
    m.printed();
  });

  test("without a terminal it asks nothing, writes nothing and names the variable to set", async () => {
    const m = await machine();
    m.io.interactive = false;
    expect(await run(["auth", "login"], m.io)).toBe(2);
    expect(m.asked).toEqual([]);
    expect(m.err()).toContain("auth login needs an interactive terminal");
    expect(m.err()).toContain("  LINEAR_API_KEY  Linear API key:");
    expect(m.err()).not.toContain("TURSO");
    expect(await stat(m.credentials).catch(() => null)).toBeNull();
  });

  test("cancelling a prompt saves nothing", async () => {
    const m = await machine();
    m.answers.LINEAR_API_KEY = null;
    expect(await run(["auth", "login"], m.io)).toBe(130);
    expect(await stat(m.credentials).catch(() => null)).toBeNull();
    m.printed();
  });
});

describe("armada auth status", () => {
  test("says where each key comes from, the environment first, and never prints a value", async () => {
    const m = await machine({ LINEAR_API_KEY: LINEAR });
    await mkdir(dirname(m.credentials), { recursive: true });
    await writeFile(m.credentials, "LINEAR_API_KEY=lin_api_CANARY_stored\n");
    await chmod(m.credentials, 0o644);
    await writeFile(m.config, "");

    expect(await run(["auth", "status"], m.io)).toBe(0);
    const text = m.printed();
    expect(text).not.toContain("lin_api_CANARY_stored");
    expect(text).toBe(`Armada keys
  LINEAR_API_KEY  set      environment (LINEAR_API_KEY)
  GITHUB_TOKEN    missing  set GITHUB_TOKEN or run \`gh auth login\`

Credentials file  ${m.credentials} (mode 0644)
Personal config   ${m.config}
! ${m.credentials} can be read by other users (mode 0644); run: chmod 600 ${m.credentials}

Armada sign-in
  API        https://armada.thevibecompany.co (built in)
  Signed in  no: run \`armada login\`, or set ARMADA_API_KEY on a headless coordinator
`);

    m.reset();
    expect(await run(["auth", "status", "--json"], m.io)).toBe(0);
    const status = JSON.parse(m.printed());
    expect(status.keys.map((k: { variable: string; present: boolean }) => [k.variable, k.present])).toEqual([
      ["LINEAR_API_KEY", true],
      ["GITHUB_TOKEN", false],
    ]);
  });
});

describe("armada auth logout", () => {
  test("removes Armada's keys and the retired fleet database keys, keeps every other line, and says which ones the environment still sets", async () => {
    const m = await machine({ LINEAR_API_KEY: "lin_api_env" });
    // Keys earlier versions kept for the fleet database: never read, and removed with the rest.
    const retired =
      "ARMADA_TURSO_URL=libsql://CANARY-db.example.io\nARMADA_TURSO_TOKEN=CANARY_db_token\nARMADA_TURSO_LEASE=CANARY_lease\n";
    await mkdir(dirname(m.credentials), { recursive: true });
    // A malformed key line still holds a secret: logout removes it too.
    await writeFile(m.credentials, `# mine\nOTHER_TOOL=keep\n${retired}LINEAR_API_KEY='${LINEAR}\n`);

    expect(await run(["auth", "logout"], m.io)).toBe(0);
    expect(await readFile(m.credentials, "utf8")).toBe("# mine\nOTHER_TOOL=keep\n");
    const text = m.printed();
    expect(text).not.toContain("CANARY");
    expect(text).toBe(
      `Removed LINEAR_API_KEY, ARMADA_TURSO_URL, ARMADA_TURSO_TOKEN, ARMADA_TURSO_LEASE from ${m.credentials}.\nStill set in the environment, and still used: LINEAR_API_KEY. Unset them to stop using them.\n`,
    );
  });
});

describe("armada status with the machine store", () => {
  test("uses the stored Linear key, and an environment key wins over it", async () => {
    const m = await machine();
    m.answers.LINEAR_API_KEY = "lin_api_stored";
    await run(["auth", "login"], m.io);

    expect(await run(["status", "--json"], m.io)).toBe(0);
    expect(m.calls[0]?.authorization).toBe("lin_api_stored");

    const withEnv = await machine({ LINEAR_API_KEY: "lin_api_env", XDG_CONFIG_HOME: dirname(dirname(m.credentials)) });
    expect(await run(["status", "--json"], withEnv.io)).toBe(0);
    expect(withEnv.calls[0]?.authorization).toBe("lin_api_env");
  });

  test("with no key anywhere, the error names the variable and the login command", async () => {
    const m = await machine();
    expect(await run(["status"], m.io)).toBe(2);
    expect(m.err()).toContain("LINEAR_API_KEY is not set. Set it in the environment, run `armada auth login`");
  });
});

test("prompt input keeps typed and pasted characters, honours backspace, skips arrow keys and cancels", () => {
  let line = feedLine(emptyLine(), "lin_");
  line = feedLine(line, "api\u001b[D_x\u007fK\r ignored");
  expect(line.result).toBe("lin_api_K");
  expect(feedLine(emptyLine(), "abc\u0003").result).toBeNull();
  expect(feedLine(emptyLine(), "\u0004").result).toBeNull();
  // A visible prompt echoes the difference: erase what changed, then type the rest.
  expect(echo("libsql:/", "libsql:")).toBe("\b \b");
  expect(echo("lib", "libsql")).toBe("sql");
});
