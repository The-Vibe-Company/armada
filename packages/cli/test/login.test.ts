import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARMADA_URL, fakeArmada, NOW } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";

// Canary secrets: no output may ever contain them.
const TOKEN = "CANARY_session_token";
const KEY = "armada_CANARY_api_key";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A fresh machine (its config home a temporary directory) talking to a fake Armada. */
async function machine(armada: ReturnType<typeof fakeArmada>, env: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "armada-login-"));
  dirs.push(home);
  const out: string[] = [];
  const opened: string[] = [];
  let stdin = "";
  const io: Io = {
    cwd: "/work/widgets",
    env: { XDG_CONFIG_HOME: home, ARMADA_API_URL: ARMADA_URL, ...env },
    readFile: async () => null,
    stdout: (t) => out.push(t),
    stderr: (t) => out.push(t),
    ghToken: () => null,
    fetch: armada.fetch,
    now: () => NOW,
    sleep: async () => {},
    interactive: true,
    prompt: async () => KEY,
    openUrl: (url) => {
      opened.push(url);
      return true;
    },
    readStdin: async () => stdin,
  };
  return {
    io,
    opened,
    credentials: join(home, "armada", "credentials"),
    pipe: (text: string) => {
      io.interactive = false;
      stdin = text;
    },
    /** Everything printed since the last call; asserts no secret leaked. */
    printed: () => {
      const text = out.splice(0).join("");
      for (const secret of [TOKEN, KEY]) expect(text).not.toContain(secret);
      return text;
    },
  };
}

describe("armada login in a browser", () => {
  test("shows the code, opens the page, stores the session 0600; whoami names the person and organization; logout revokes it", async () => {
    const armada = fakeArmada({ token: TOKEN, polls: ["pending", "slow_down", "approve"] });
    const m = await machine(armada);

    expect(await run(["login"], m.io)).toBe(0);
    const shown = m.printed();
    expect(shown).toContain("First copy your one-time code: WDJB-MJHT");
    expect(shown).toContain(`Then confirm it at ${ARMADA_URL}/device?user_code=WDJBMJHT`);
    expect(m.opened).toEqual([`${ARMADA_URL}/device?user_code=WDJBMJHT`]);
    expect(shown).toContain("Signed in to armada.example.test as Ada Example <ada@example.test>, Acme (owner).");
    expect(await readFile(m.credentials, "utf8")).toBe(
      `ARMADA_SESSION_TOKEN=${TOKEN}\nARMADA_SIGNED_IN_TO=${ARMADA_URL}\n`,
    );
    expect((await stat(m.credentials)).mode & 0o777).toBe(0o600);

    expect(await run(["whoami"], m.io)).toBe(0);
    expect(m.printed()).toBe("Signed in to armada.example.test as Ada Example <ada@example.test>, Acme (owner).\n");
    expect(await run(["whoami", "--json"], m.io)).toBe(0);
    expect(JSON.parse(m.printed())).toMatchObject({
      via: "session",
      user: { email: "ada@example.test" },
      organization: { name: "Acme" },
      api: ARMADA_URL,
      source: { kind: "store" },
    });
    expect(await run(["auth", "status"], m.io)).toBe(0);
    expect(m.printed()).toContain(
      `  API        ${ARMADA_URL} (environment (ARMADA_API_URL))\n  Signed in  with the session of \`armada login\`, from the credentials file`,
    );

    expect(await run(["logout"], m.io)).toBe(0);
    expect(m.printed()).toStartWith("Signed out of armada.example.test");
    expect(armada.calls.at(-1)).toMatchObject({ method: "DELETE", path: "session", authorization: `Bearer ${TOKEN}` });
    expect(armada.sessions.size).toBe(0);
    expect(await readFile(m.credentials, "utf8")).toBe("");

    // Signed out: a command that needs a sign-in says so and names the next step.
    expect(await run(["whoami"], m.io)).toBe(2);
    expect(m.printed()).toBe(
      "armada: not signed in to Armada (armada.example.test). A person signs in with `armada login`; a headless coordinator sets ARMADA_API_KEY to an organization API key\nNext: armada login\n",
    );
  });

  test("a denied code stores nothing; an Armada without accounts refuses with its own next step", async () => {
    const denied = await machine(fakeArmada({ polls: ["pending", "access_denied"] }));
    expect(await run(["login"], denied.io)).toBe(1);
    expect(denied.printed()).toEndWith("armada: the sign-in was denied in the browser\nNext: armada login\n");
    expect(await stat(denied.credentials).catch(() => null)).toBeNull();

    const password = await machine(fakeArmada({ accounts: false }));
    expect(await run(["login"], password.io)).toBe(1);
    expect(password.printed()).toBe(
      "armada: Armada refused to start the sign-in: this Armada has no accounts yet\nNext: ask its owner to set up accounts\n",
    );
  });
});

describe("a headless coordinator with an API key", () => {
  test("login --api-key reads the key from stdin, checks it, stores it; revoked, whoami says to sign in again", async () => {
    const armada = fakeArmada({ keys: { [KEY]: "cloud coordinator" } });
    const m = await machine(armada);
    m.pipe(`${KEY}\n`);
    expect(await run(["login", "--api-key"], m.io)).toBe(0);
    expect(m.printed()).toContain('Signed in to armada.example.test as the API key "cloud coordinator" of Acme.');
    expect(await readFile(m.credentials, "utf8")).toBe(`ARMADA_API_KEY=${KEY}\nARMADA_SIGNED_IN_TO=${ARMADA_URL}\n`);
    expect(armada.calls.at(-1)).toMatchObject({ path: "session", apiKey: KEY, authorization: null });

    armada.keys.delete(KEY);
    expect(await run(["whoami"], m.io)).toBe(1);
    expect(m.printed()).toBe(
      "armada: this Armada API key is not valid: it was revoked, or never existed\nNext: armada login\n",
    );

    // A key that does not work is never stored.
    m.pipe("armada_mistyped\n");
    await run(["logout"], m.io);
    m.printed();
    expect(await run(["login", "--api-key"], m.io)).toBe(1);
    expect(await readFile(m.credentials, "utf8")).toBe("");
  });

  test("ARMADA_API_KEY in the environment signs in with nothing stored, and wins over a stored session", async () => {
    const armada = fakeArmada({ keys: { [KEY]: "ci" } });
    const m = await machine(armada, { ARMADA_API_KEY: KEY });
    expect(await run(["whoami"], m.io)).toBe(0);
    expect(m.printed()).toBe('Signed in to armada.example.test as the API key "ci" of Acme.\n');
    expect(await run(["logout"], m.io)).toBe(0);
    expect(m.printed()).toContain("ARMADA_API_KEY is still set in the environment");
  });
});

describe("where a sign-in may go", () => {
  test("a key typed on the command line is refused without being printed", async () => {
    const m = await machine(fakeArmada());
    expect(await run(["login", "--api-key", KEY], m.io)).toBe(2);
    expect(m.printed()).toStartWith("armada: login takes no argument: an API key is read from a hidden prompt");
    expect(await run(["login", `--api-key=${KEY}`], m.io)).toBe(2);
    expect(m.printed()).toStartWith("armada: unknown option --api-key=…\n");
  });

  test("a sign-in is sent only to the Armada that issued it", async () => {
    const armada = fakeArmada({ token: TOKEN });
    const m = await machine(armada);
    expect(await run(["login"], m.io)).toBe(0);
    m.printed();
    const calls = armada.calls.length;

    m.io.env.ARMADA_API_URL = "https://other-armada.example.test";
    expect(await run(["whoami"], m.io)).toBe(2);
    expect(m.printed()).toBe(
      "armada: this terminal is signed in to armada.example.test, not to other-armada.example.test (named by ARMADA_API_URL or [api] url); its sign-in is never sent to another Armada\nNext: armada login to sign in to other-armada.example.test, or point ARMADA_API_URL back to https://armada.example.test\n",
    );
    // Signing out still revokes the session where it was issued.
    expect(await run(["logout"], m.io)).toBe(0);
    expect(m.printed()).toStartWith("Signed out of armada.example.test");
    expect(armada.calls.slice(calls)).toMatchObject([{ method: "DELETE", path: "session" }]);
    expect(armada.sessions.size).toBe(0);
  });
});
