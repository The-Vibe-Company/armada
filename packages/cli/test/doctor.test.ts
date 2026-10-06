// `armada doctor`'s checks of this terminal: whether it is signed in to
// Armada (so its briefs give workers a launch token), whether keys left in the
// credentials file are no longer needed, whether this CLI is as recent as
// Armada expects, whether the conductor command is found, and which secrets
// the project expects are not set in Armada. A fake Armada answers.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Check, checkPublished, type Fetch, NPM_REGISTRY_URL, type ServerCli } from "@armada/core";
import { ARMADA_URL, DEMO_TOML, type FakeVault, fakeArmada, NOW, recordedFetch } from "../../core/test/support.ts";
import { version } from "../package.json" with { type: "json" };
import { run } from "../src/cli.ts";
import { BUNDLED_CONDUCTOR, buildDoctor } from "../src/doctor.ts";
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
  more: {
    cli?: ServerCli;
    exec?: Exec;
    toml?: string;
    secrets?: Record<string, Record<string, string>>;
    fetch?: Io["fetch"];
  } = {},
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
    ...(more.secrets ? { secrets: more.secrets } : {}),
  });
  const out: string[] = [];
  const errs: string[] = [];
  const io: Io = {
    cwd: home,
    env: { XDG_CONFIG_HOME: home, ARMADA_API_URL: ARMADA_URL, ...env },
    readFile: async (path) => (path === join(home, "armada.toml") ? (more.toml ?? DEMO_TOML) : null),
    stdout: (t) => out.push(t),
    stderr: (t) => errs.push(t),
    ghToken: () => null,
    fetch: more.fetch ?? armada.fetch,
    now: () => NOW,
    sleep: async () => {},
    ...(more.exec ? { exec: more.exec } : {}),
  };
  /** The sign-in, key-file, version and conductor checks of `armada doctor --json`. */
  const doctor = async (ids = ["sign-in", "cli-version", "local-keys", "retired-keys", "conductor-cli", "secrets"]) => {
    await run(["doctor", "--json"], io);
    const text = out.splice(0).join("");
    for (const secret of [KEY, SESSION, LINEAR]) expect([text, ...errs].join("")).not.toContain(secret);
    const report = JSON.parse(text.slice(text.indexOf("{"))) as { checks: Check[] };
    return report.checks.filter((c) => ids.includes(c.id));
  };
  /** What the last runs printed on stderr, emptied. */
  const stderr = () => errs.splice(0).join("");
  const inbox = async () => {
    expect(await run(["inbox", "--json"], io)).toBe(0);
    out.splice(0);
  };
  return { doctor, inbox, stderr, home, credentials: join(home, "armada", "credentials") };
}

describe("armada doctor: parent auto-close", () => {
  for (const enabled of [true, false, null] as const) {
    test(`reports the root team's setting: ${enabled}`, async () => {
      const t = await terminal({ LINEAR_API_KEY: LINEAR }, {}, null, {
        toml: DEMO_TOML,
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init.body));
          if (body.query?.includes("query ParentAutoClose")) {
            expect(body.variables.id).toBe("DEMO-1");
            return Response.json({ data: { issue: { team: { name: "Example", autoCloseParentIssues: enabled } } } });
          }
          return Response.json({ errors: [{ message: "not part of this test" }] });
        },
      });
      const checks = await t.doctor(["parent-auto-close"]);
      expect(checks).toHaveLength(1);
      expect(checks[0]?.level).toBe(enabled ? "ok" : "warning");
      expect(checks[0]?.message).toContain("Example");
      if (enabled) expect(checks[0]?.fix).toBeNull();
      else expect(checks[0]?.fix).toContain("Settings > Team > Workflow > Parent auto-close");
    });
  }
  test("failed reads warn without exposing provider text", async () => {
    const t = await terminal({ LINEAR_API_KEY: LINEAR }, {}, null, {
      toml: DEMO_TOML,
      fetch: async (_url, init) =>
        Response.json({
          errors: [{ message: String(init.body).includes("query ParentAutoClose") ? LINEAR : "unavailable" }],
        }),
    });
    const checks = await t.doctor(["parent-auto-close"]);
    expect(checks[0]?.level).toBe("warning");
    expect(checks[0]?.message).toContain("not checked");
  });
});

describe("armada doctor: GitHub merge rules", () => {
  const ids = [
    "merge-rules",
    "merge-checks",
    "merge-squash",
    "merge-approvals",
    "merge-queue",
    "merge-delete-branches",
  ];
  test("no token produces exactly one not-checked warning", async () => {
    const t = await terminal({}, {}, null, { toml: DEMO_TOML });
    expect(await t.doctor(ids)).toMatchObject([
      { id: "merge-rules", level: "warning", message: "GitHub branch rules not checked: no GitHub token" },
    ]);
  });

  test("a token denied access yields one warning without exposing the response", async () => {
    const t = await terminal({ GITHUB_TOKEN: "github_CANARY" }, {}, null, {
      toml: DEMO_TOML,
      fetch: async () => new Response("github_CANARY", { status: 403 }),
    });
    const checks = await t.doctor(ids);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.level).toBe("warning");
    expect(JSON.stringify(checks)).not.toContain("github_CANARY");
  });

  test("appends all five compatibility lines despite unavailable classic protection", async () => {
    const t = await terminal({ GITHUB_TOKEN: "github_CANARY" }, {}, null, {
      toml: DEMO_TOML,
      fetch: async (url) => {
        if (url.includes("/rules/branches/"))
          return Response.json([
            { type: "pull_request", parameters: { required_approving_review_count: 1 } },
            { type: "merge_queue" },
          ]);
        if (url.endsWith("/protection")) return new Response("denied", { status: 403 });
        if (url.startsWith("https://api.github.com/repos/"))
          return Response.json({ default_branch: "trunk", allow_squash_merge: false, delete_branch_on_merge: true });
        throw new Error("unexpected read");
      },
    });
    const checks = await t.doctor(ids);
    expect(checks).toHaveLength(5);
    expect(checks.map((c) => c.level)).toEqual(["ok", "error", "error", "error", "warning"]);
  });
});

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

describe("a newer Armada release", () => {
  const notice = `armada: Armada 99.1.0 is out (you run ${version}): armada upgrade. Changes: https://github.com/The-Vibe-Company/armada/releases/tag/v99.1.0\n`;

  test("only inbox/status carry the daily notice; doctor stays quiet", async () => {
    const t = await terminal({ ARMADA_API_KEY: KEY }, {}, vault(), { cli: { minimum: "0.0.1", latest: "99.1.0" } });
    await t.doctor();
    expect(t.stderr()).toBe("");
    await t.inbox();
    expect(t.stderr()).toBe(notice);
    await t.inbox();
    expect(t.stderr()).toBe("");
    expect(JSON.parse(await readFile(join(t.home, "armada", "releases.json"), "utf8"))).toEqual({
      noticed: [{ version: "99.1.0", at: NOW.toISOString() }],
    });
  });

  test("a listed release stays quiet until the server verifies its tarball", async () => {
    const server = { minimum: "0.0.1", latest: version };
    const newer = "99.1.0";
    let ready = false;
    const refresh = async () => {
      const answer = await checkPublished(newer, async (url) =>
        url === NPM_REGISTRY_URL
          ? Response.json({
              versions: Object.fromEntries(
                [newer, version].map((candidate) => [
                  candidate,
                  {
                    dist: { tarball: `https://registry.npmjs.org/armada-${candidate}.tgz` },
                  },
                ]),
              ),
            })
          : new Response(null, { status: url.includes(newer) && !ready ? 404 : 200 }),
      );
      if (answer.state === "published") server.latest = newer;
      if (answer.state === "missing" && answer.newest) server.latest = answer.newest;
    };
    const terminalIo = await terminal({ ARMADA_API_KEY: KEY }, {}, vault(), { cli: server });
    await refresh();
    await terminalIo.inbox();
    expect(terminalIo.stderr()).toBe("");
    ready = true;
    await refresh();
    await terminalIo.inbox();
    expect(terminalIo.stderr()).toBe(notice);
    await terminalIo.inbox();
    expect(terminalIo.stderr()).toBe("");
  });

  test("a worker is never told: it installs the version its brief names", async () => {
    const t = await terminal({ ARMADA_API_KEY: KEY, ARMADA_TICKET: "DEMO-2" }, {}, vault(), {
      cli: { minimum: "0.0.1", latest: "99.1.0" },
    });
    await t.doctor();
    expect(t.stderr()).toBe("");
  });

  test("a CLI older than the server's minimum gets the upgrade line only", async () => {
    const t = await terminal({ ARMADA_API_KEY: KEY }, {}, vault(), { cli: { minimum: "99.0.0", latest: "99.1.0" } });
    await t.doctor();
    expect(t.stderr()).not.toContain("is out");
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

  test("on PATH, it is ok; a project without a profile on Conductor is not checked", async () => {
    expect(await conductor(["conductor"])).toEqual({
      id: "conductor-cli",
      level: "ok",
      message: "conductor 0.89.2 is on PATH",
      fix: null,
    });
    expect(await conductor([], {}, TOML.slice(0, TOML.indexOf("[conductor")))).toBeUndefined();
    expect(await conductor([], {}, TOML.replace('agent = "claude"', 'runtime = "claude-code"'))).toBeUndefined();
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

describe("armada doctor: the secrets the project expects", () => {
  const toml = (names: string) =>
    `[project]\nname = "Widgets"\nslug = "widgets"\n\n[tracker]\nprogram_root = "DEMO-1"\n\n[github]\nrepository = "acme/widgets"\n\n[secrets]\nnames = ${names}\n`;

  test("names those not set in Armada, by name only; all set is ok; signed out it says it could not check", async () => {
    const t = await terminal({ ARMADA_API_KEY: KEY }, {}, null, {
      secrets: { widgets: { OPENAI_API_KEY: "sk-CANARY-1" }, "": { SENTRY_DSN: "CANARY-dsn" } },
    });
    await writeFile(join(t.home, "armada.toml"), toml(`["OPENAI_API_KEY", "SENTRY_DSN", "TEST_DATABASE_URL"]`));
    const missing = (await t.doctor()).find((c) => c.id === "secrets");
    expect(missing).toEqual({
      id: "secrets",
      level: "warning",
      message:
        "the project expects the secrets OPENAI_API_KEY, SENTRY_DSN, TEST_DATABASE_URL; not set in Armada: TEST_DATABASE_URL",
      fix: "an owner or admin runs `armada secrets set <NAME>` for each (or sets it on the Keys page of Armada)",
    });
    await writeFile(join(t.home, "armada.toml"), toml(`["OPENAI_API_KEY", "SENTRY_DSN"]`));
    expect((await t.doctor()).find((c) => c.id === "secrets")?.level).toBe("ok");

    const out = await terminal({}, {}, null);
    await writeFile(join(out.home, "armada.toml"), toml(`["OPENAI_API_KEY"]`));
    expect((await out.doctor()).find((c) => c.id === "secrets")?.message).toBe(
      "the project expects the secrets OPENAI_API_KEY; not checked: not signed in to Armada",
    );
  });
});

describe("armada doctor: repository identity", () => {
  test("origin mismatch, equivalent forms, GitHub rename and unavailable checks", async () => {
    const github = recordedFetch({ repository: { full_name: "new-org/new-widgets" } });
    const requests: { command: string; args: string[]; cwd: string; timeoutMs?: number }[] = [];
    let remote: string | null = "git@github.com:acme/other.git";
    let fail = false;
    const exec: Exec = async (command, args, options) => {
      if (args.join(" ") === "remote get-url origin") {
        requests.push({ command, args, ...options });
        if (fail) throw new Error("CANARY remote credentials");
        return { code: remote === null ? 2 : 0, stdout: remote ?? "", stderr: "CANARY remote credentials" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    const t = await terminal({}, {}, null, { toml: DEMO_TOML });
    let token: string | undefined = "CANARY-github-token";
    let fetch: Fetch = github.fetch;
    const waits: number[] = [];
    const notices: string[] = [];
    const check = async () => {
      const report = await buildDoctor(
        {
          cwd: t.home,
          env: { XDG_CONFIG_HOME: t.home, GITHUB_TOKEN: token },
          readFile: async () => null,
          stdout: () => {},
          stderr: (message) => notices.push(message),
          now: () => NOW,
          sleep: async (ms) => {
            waits.push(ms);
          },
          ghToken: () => null,
          exec,
          fetch,
        },
        version,
      );
      expect(JSON.stringify(report)).not.toContain("CANARY");
      return report.checks.filter((c) => ["git-origin", "github-repository"].includes(c.id));
    };
    expect(await check()).toEqual([
      {
        id: "git-origin",
        level: "error",
        message: "origin names acme/other, but armada.toml names acme/widgets",
        fix: 'set [github] repository = "acme/other" in armada.toml, or run `git remote set-url origin https://github.com/acme/widgets.git` if the configured repository is correct',
      },
      {
        id: "github-repository",
        level: "warning",
        message: "GitHub reports acme/widgets as new-org/new-widgets: the repository was renamed or moved",
        fix: 'set [github] repository = "new-org/new-widgets" in armada.toml',
      },
    ]);
    expect(requests[0]).toMatchObject({
      command: "git",
      args: ["remote", "get-url", "origin"],
      cwd: t.home,
      timeoutMs: 10_000,
    });
    expect(github.calls[0]).toEqual({
      url: "https://api.github.com/repos/acme/widgets",
      operation: "Repository",
      variables: {},
      authorization: `Bearer ${token}`,
    });
    fetch = recordedFetch({ repository: { full_name: "ACME/Widgets" } }).fetch;
    for (const form of [
      "https://github.com/ACME/widgets.git",
      "git@github.com:acme/Widgets",
      "ssh://git@github.com/acme/widgets.git",
    ]) {
      remote = form;
      expect((await check()).map((c) => c.level)).toEqual(["ok", "ok"]);
    }
    token = undefined;
    expect((await check())[1]).toMatchObject({
      level: "warning",
      message: "GitHub repository not checked: no GitHub token",
    });
    remote = null;
    expect((await check())[0]).toMatchObject({
      level: "error",
      message: "origin repository not checked: git could not read origin",
    });
    fail = true;
    expect((await check())[0]?.level).toBe("error");
    fail = false;
    remote = "https://CANARY@other.test/acme/widgets";
    expect((await check())[0]).toMatchObject({
      level: "error",
      message: "origin is not a recognized GitHub repository remote",
    });
    token = "CANARY-github-token";
    fetch = async () => new Response(null, { status: 404 });
    expect((await check())[1]).toMatchObject({
      level: "warning",
      message: "GitHub repository not checked: GitHub API HTTP 404",
    });
    const recovered = recordedFetch({ repository: { full_name: "acme/widgets" } });
    let attempts = 0;
    remote = "git@github.com:acme/widgets.git";
    fetch = async (url, init) =>
      attempts++ === 0
        ? new Response(null, {
            status: 503,
            headers: { "Retry-After": new Date(NOW.getTime() + 2000).toUTCString() },
          })
        : recovered.fetch(url, init);
    expect((await check()).map((c) => c.level)).toEqual(["ok", "ok"]);
    // Repository identity retries once; branch compatibility also reads repository merge settings.
    expect(attempts).toBe(3);
    expect(waits).toEqual([2000]);
    expect(notices).toContain("armada: GitHub answered 503; trying again in 2 s (2/3)\n");
    expect(notices.join("")).not.toContain("CANARY");
  });
});
