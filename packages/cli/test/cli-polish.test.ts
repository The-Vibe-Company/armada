import { expect, test } from "bun:test";
import type { AuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

async function invoke(argv: string[], token = false, response?: Response) {
  let out = "",
    err = "";
  const io = {
    out: (text: string) => {
      out += text;
    },
    err: (text: string) => {
      err += text;
    },
  };
  const auth: AuthIo = {
    ...io,
    env: token ? { ARMADA_TOKEN: "test_token" } : {},
    session: memorySessionStore(),
    now: () => new Date(0),
    open: () => {},
    fetch: async () => {
      if (response) return response;
      throw new Error("Unexpected request");
    },
  };
  const code = await run(argv, io, { auth });
  return { code, out, err };
}

test("bare families share login-free successful discovery", async () => {
  for (const family of [
    "snapshot",
    "golden",
    "host",
    "template",
    "routine",
    "vars",
    "secrets",
    "mcp",
    "creds",
    "org",
    "account",
    "github",
    "token",
    "skill",
  ]) {
    const bare = await invoke([family]);
    const help = await invoke([family, "--help"]);
    expect(bare).toEqual(help);
    expect(bare.code).toBe(0);
    expect(bare.err).toBe("");
    expect(bare.out).toContain("armada");
    expect((await invoke([family, "unknown-subcommand"])).code).toBe(2);
  }
});

test("completion covers every root help command and options in every shell", async () => {
  const help = await invoke(["--help"]);
  for (const shell of ["bash", "zsh", "fish"]) {
    const result = await invoke(["completion", shell]);
    for (const match of help.out.matchAll(/armada ([a-z][a-z-]*)/g)) expect(result.out).toContain(match[1]!);
    for (const command of ["recovery", "interrupt", "steer", "exec"]) expect(result.out).toContain(command);
    expect(result.out).toContain(shell === "fish" ? "-l 'request-id'" : "--request-id");
    expect(result.out).toContain(shell === "fish" ? "-l 'page-info'" : "--page-info");
    for (const option of ["since", "prompt-file", "cron", "timezone", "max-runs-per-day"])
      expect(result.out).toContain(shell === "fish" ? `-l '${option}'` : `--${option}`);
  }
});

test("usage and authentication failures give relevant recovery", async () => {
  const usage = await invoke(["list", "--limit", "0"]);
  expect(usage.code).toBe(2);
  expect(usage.err).toContain("armada list --help");
  expect(usage.err).not.toContain("inspect armada list");
  for (const args of [
    ["creds", "set", "bogus"],
    ["launch", "starter", "--agent", "codex", "--size", "bad"],
    ["frobnicate"],
  ]) {
    const invalid = await invoke(args);
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain(args[0] === "frobnicate" ? "armada --help" : `armada ${args[0]}`);
    expect(invalid.err).not.toContain("armada doctor");
    expect(invalid.err).not.toContain("frobnicate --help");
  }
  const auth = await invoke(["org", "list"]);
  expect(auth.code).toBe(3);
  expect(auth.err).toContain("armada login");
  expect(auth.err).not.toContain("armada doctor");
});

test("invalid agents list the catalog for list and Docker launch", async () => {
  for (const argv of [
    ["list", "--agent", "bogus"],
    ["launch", "--provider", "docker", "--agent", "bogus"],
  ]) {
    const result = await invoke(argv);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/claude.*codex.*opencode/);
  }
});

test("explicit launches require an agent on both Docker and golden paths", async () => {
  for (const argv of [
    ["launch", "starter"],
    ["launch", "--provider", "docker", "--host", "office"],
  ]) {
    const result = await invoke(argv);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Pass --agent claude or codex or opencode.");
  }
});

test("Docker placement distinguishes absent and malformed host selectors", async () => {
  const args = ["launch", "--provider", "docker", "--agent", "codex", "--org", "00000000-0000-0000-0000-000000000001"];
  const missing = await invoke(args);
  expect(missing.code).toBe(2);
  expect(missing.err).toContain("requires --host UUID|NAME or --golden SNAPSHOT_UUID");
  const malformed = await invoke([...args, "--host", "x".repeat(65)]);
  expect(malformed.code).toBe(2);
  expect(malformed.err).toContain("--host requires a UUID or exact host name");
});

test("token, deployment and uncertain launch errors retain appropriate recovery", async () => {
  const token = await invoke(
    ["org", "list"],
    true,
    Response.json({ error: { code: "unauthorized", message: "Expired token." } }, { status: 401 }),
  );
  expect(token.code).toBe(3);
  expect(token.err).toContain("check or replace ARMADA_TOKEN");
  expect(token.err).not.toContain("armada doctor");
  const deployment = await invoke(
    ["org", "list"],
    true,
    Response.json({ error: { code: "unknown_route", message: "Unknown route." } }, { status: 404 }),
  );
  expect(deployment.err).toContain("Ask an administrator");
  expect(deployment.err).not.toContain("armada doctor");
  const launch = await invoke(["launch", "web", "--agent", "codex"], true);
  expect(launch.err).toContain("Run armada list to check before retrying");
  expect(launch.err).not.toContain("armada doctor");
});
