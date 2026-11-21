import { describe, expect, test } from "bun:test";
import { VERSION } from "@armada/core";
import { type Deps, run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

async function capture(argv: string[], deps: Deps = {}) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (text) => (out += text), err: (text) => (err += text) }, deps);
  return { code, out, err };
}

describe("run", () => {
  test("--version prints the version alone", async () => {
    expect(await capture(["--version"])).toEqual({ code: 0, out: `${VERSION}\n`, err: "" });
  });

  test("root help aliases need no configured profile or external I/O", async () => {
    const forbidden = () => {
      throw new Error("Help attempted external I/O");
    };
    for (const alias of ["help", "--help", "-h"]) {
      for (const explicit of [true, false]) {
        const result = await capture(explicit ? ["--profile", "new-user", alias] : [alias], {
          env: explicit ? {} : { ARMADA_PROFILE: "new-user" },
          fetch: Object.assign(forbidden, { preconnect: forbidden }),
          readStdin: forbidden,
        });
        expect(result.code).toBe(0);
        expect(result.err).toBe("");
        expect(result.out).toContain("Quick start / common examples:");
        expect(result.out).toContain("armada login");
      }
    }
  });

  test("no command prints the help", async () => {
    const { code, out } = await capture([], {
      auth: {
        out: () => undefined,
        err: () => undefined,
        env: {},
        now: () => new Date(0),
        open: () => {
          throw new Error("Help must not open a browser");
        },
        fetch: async () => Response.json({}),
        session: memorySessionStore({ accessToken: "saved", refreshToken: "refresh", expiresAt: "2099-01-01" }),
      },
    });
    expect(code).toBe(0);
    expect(out).toContain("armada snapshot new");
    expect(out).toContain("armada new <snapshot> --agent claude|codex");
    expect(out).toContain("armada login");
    expect(out).toContain("armada api token/create");
    expect(out).toContain("--profile overrides ARMADA_PROFILE");
    expect(out).toContain("ARMADA_TOKEN is not isolated by profiles");
  });

  test.each([
    "new",
    "ls",
    "info",
    "bind-credential",
    "rm",
    "extend",
    "report",
    "prompt",
    "exec",
    "stop",
    "interrupt",
    "mcp",
    "login",
    "logout",
    "org",
    "account",
  ])("%s help needs no login or server request", async (command) => {
    const { code, out, err } = await capture([command, "--help"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("Usage:");
    expect(out).toContain(command);
  });

  test("unknown commands use the human or JSON usage error contract", async () => {
    const forbidden = () => {
      throw new Error("Unknown command attempted I/O");
    };
    const deps: Deps = {
      auth: {
        env: {},
        out: forbidden,
        err: forbidden,
        open: forbidden,
        now: () => new Date(0),
        fetch: forbidden,
        session: memorySessionStore(),
      },
      readStdin: forbidden,
    };
    for (const [args, command, checkHelp] of [
      [["frobnicate"], "frobnicate"],
      [["token", "create"], "token", true],
      [["routine", "create"], "routine", true],
      [["org", "create"], "org create", true],
      [["--profile", "unconfigured", "org", "members", "list"], "org members", true],
      [["org", "invitations", "accept"], "org invitations", true],
      [["--profile", "unconfigured", "github", "connect"], "github"],
      [["--profile", "unconfigured", "creds", "list"], "creds", true],
      [["list"], "list", true],
      [["send"], "send", true],
      [["steer"], "steer", true],
      ...["status", "detail", "wait", "advice", "recovery"].map((verb) => [[verb], verb, true] as const),
      [["snapshot", "frobnicate", "--org", "org_placeholder"], "snapshot frobnicate"],
      ...[
        "create",
        "list",
        "get",
        "remove",
        "visibility",
        "capabilities",
        "size-policy",
        "build-status",
        "build-find",
        "build-cancel",
        "retirement",
        "connect",
        "snapshot",
      ].map((verb) => [["snapshot", verb], `snapshot ${verb}`, true] as const),
      [["golden", "snapshot", "web", "--provider", "docker"], "golden", true],
    ] as const) {
      for (const json of [false, true]) {
        const diagnostic = `unknown command '${command}'`;
        const { code, out, err } = await capture([...args, ...(json ? ["--json"] : [])], deps);
        expect(code).toBe(2);
        expect(out).toBe("");
        if (json) {
          expect(JSON.parse(err)).toEqual({
            error: {
              code: "usage",
              message: `${diagnostic}. Run 'armada --help'.`,
              hint: expect.stringContaining("--help"),
            },
          });
        } else {
          expect(err).toContain(diagnostic);
          expect(err).toContain("armada --help");
        }
      }
      if (checkHelp) {
        const help = await capture(
          [...args.slice(0, args[0] === "--profile" || args[0] === "org" ? args.length : 2), "--help"],
          deps,
        );
        expect(help.code).toBe(2);
        expect(help.out).toBe("");
        expect(help.err).toContain(`unknown command '${command}'`);
      }
    }
  });
});

test("bare discovery families succeed without profile, account or input I/O", async () => {
  const forbidden = () => {
    throw new Error("Usage attempted external I/O");
  };
  for (const command of ["host", "template", "vars", "secrets"]) {
    const result = await capture(["--profile", "new-user", command], {
      env: {},
      fetch: Object.assign(forbidden, { preconnect: forbidden }),
      readStdin: forbidden,
      get auth(): never {
        return forbidden();
      },
    });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    const family = command === "golden" ? "snapshot" : command;
    expect(result.out).toContain(`Usage: armada ${family} <command>`);
    expect(result.out).toContain(`Example: armada ${family}`);
    expect(result.out).not.toContain("Quick start / common examples:");
  }
});
