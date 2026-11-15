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
    expect(out).toContain("armada snapshot create");
    expect(out).toContain("armada launch <snapshot> --agent claude|codex");
    expect(out).toContain("armada login");
    expect(out).toContain("armada token create");
    expect(out).toContain("--profile overrides ARMADA_PROFILE");
    expect(out).toContain("ARMADA_TOKEN is not isolated by profiles");
  });

  test.each([
    "launch",
    "list",
    "detail",
    "recovery",
    "status",
    "advice",
    "bind-credential",
    "rm",
    "extend",
    "report",
    "send",
    "steer",
    "exec",
    "stop",
    "wait",
    "interrupt",
    "mcp",
    "login",
    "logout",
    "token",
    "org",
    "account",
    "github",
    "creds",
  ])("%s help needs no login or server request", async (command) => {
    const { code, out, err } = await capture([command, "--help"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("Usage:");
    expect(out).toContain(command);
  });

  test.each(["--help", "-h"])("logs %s explains the reader without login, preferences or requests", async (option) => {
    let out = "";
    let err = "";
    const forbidden = async () => {
      throw new Error("Help must not perform I/O");
    };
    const io = {
      out: (text: string) => {
        out += text;
      },
      err: (text: string) => {
        err += text;
      },
    };
    const code = await run(["logs", option], io, {
      auth: {
        ...io,
        env: {},
        now: () => new Date(0),
        open: forbidden,
        fetch: forbidden,
        session: { read: forbidden, write: forbidden, clear: forbidden },
        preferences: { read: forbidden, write: forbidden },
      },
    });
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("armada logs");
    expect(out).toContain("--since");
    expect(out).toContain("--org");
    expect(out).toContain("1–1000");
    expect(out).toContain("default 100");
    expect(out).toContain("cannot combine");
    expect(out).toContain(".events[]");
    expect(out).toContain("Ctrl-C");
    expect(out).not.toContain("armada snapshot create");
  });

  test("unknown root or snapshot commands use the human or JSON usage error contract", async () => {
    const forbidden = () => {
      throw new Error("Unknown command attempted I/O");
    };
    for (const family of [undefined, "snapshot", "golden"]) {
      for (const json of [false, true]) {
        const args = family ? [family, "frobnicate", "--org", "org_placeholder"] : ["frobnicate"];
        const diagnostic = `unknown command '${family ? "snapshot " : ""}frobnicate'`;
        const { code, out, err } = await capture([...args, ...(json ? ["--json"] : [])], {
          env: {},
          fetch: Object.assign(forbidden, { preconnect: forbidden }),
          readStdin: forbidden,
        });
        expect(code).toBe(2);
        expect(out).toBe("");
        if (json) {
          expect(JSON.parse(err)).toEqual({
            error: {
              code: "usage",
              message: `${diagnostic}. Run 'armada --help'.`,
            },
          });
        } else {
          expect(err).toContain(diagnostic);
          expect(err).toContain("armada --help");
        }
      }
    }
  });
});

test("bare discovery families retain exit codes without profile, account or input I/O", async () => {
  const forbidden = () => {
    throw new Error("Usage attempted external I/O");
  };
  for (const command of ["snapshot", "golden", "host", "template", "routine", "vars", "secrets"]) {
    const result = await capture(["--profile", "new-user", command], {
      env: {},
      fetch: Object.assign(forbidden, { preconnect: forbidden }),
      readStdin: forbidden,
      get auth(): never {
        return forbidden();
      },
    });
    expect(result.code).toBe(["snapshot", "golden", "host"].includes(command) ? 2 : 0);
    expect(result.err).toBe("");
    const family = command === "golden" ? "snapshot" : command;
    expect(result.out).toContain(`Usage: armada ${family} <command>`);
    expect(result.out).toContain(`Example: armada ${family}`);
    expect(result.out).not.toContain("Quick start / common examples:");
  }
});

test.each(["snapshot", "golden"])("%s help works before login and documents snapshots", async (command) => {
  let out = "";
  let err = "";
  expect(
    await run(
      [command, "--help"],
      {
        out: (text) => {
          out += text;
        },
        err: (text) => {
          err += text;
        },
      },
      { env: {} },
    ),
  ).toBe(0);
  expect(out).toContain("armada snapshot create");
  expect(out).not.toContain("armada golden ");
  expect(err).toBe("");
});
