import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentSandboxFile } from "../src/current-sandbox.ts";
import { type Deps, run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const first = "12345678-0000-4000-8000-000000000001";
const second = "12345678-0000-4000-8000-000000000002";

function fixture(fetch: NonNullable<Deps["auth"]>["fetch"], sandbox?: string) {
  let out = "";
  let err = "";
  const io = {
    out: (text: string) => {
      out += text;
    },
    err: (text: string) => {
      err += text;
    },
  };
  const auth = {
    ...io,
    env: { ARMADA_TOKEN: "fixture", ARMADA_SANDBOX: sandbox },
    session: memorySessionStore(),
    now: () => new Date(0),
    open: () => {},
    fetch,
  };
  return {
    async run(argv: string[], options: Deps = {}) {
      return { exit: await run(argv, io, { auth, ...options }), out, err };
    },
  };
}

test("ARMADA_SANDBOX takes precedence over the directory selection", async () => {
  const cli = fixture(async (input, init) => {
    expect(new URL(String(input)).pathname).toBe("/api/v1/sandbox/status");
    const body = JSON.parse(String(init?.body));
    return Response.json({ id: body.id, status: "ready", prompt: null, settled: false });
  }, first);
  const result = await cli.run(["status"], {
    sandboxFile: { read: async () => second, write: async () => {} },
  });
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.out).id).toBe(first);
});

test("sandbox prefixes must be unique across visible pages", async () => {
  const paths: string[] = [];
  const cli = fixture(async (input, init) => {
    paths.push(new URL(String(input)).pathname);
    const { page, org } = JSON.parse(String(init?.body));
    expect(org).toBe("team");
    return Response.json({
      sandboxes: [{ id: page === 1 ? first : second }],
      hasMore: page === 1,
      nextPage: page === 1 ? 2 : null,
    });
  });
  const result = await cli.run(["status", "12345678", "--org", "team", "--json"]);
  expect(result.exit).toBe(2);
  expect(JSON.parse(result.err).error.message).toContain("ambiguous");
  expect(paths).toEqual(["/api/v1/sandbox/list", "/api/v1/sandbox/list"]);
});

test("a unique prefix from the directory file resolves to the full ID", async () => {
  const cli = fixture(async (input, init) => {
    if (new URL(String(input)).pathname === "/api/v1/sandbox/list")
      return Response.json({ sandboxes: [{ id: first }], hasMore: false, nextPage: null });
    return Response.json({
      id: JSON.parse(String(init?.body)).id,
      status: "ready",
      prompt: null,
      settled: false,
    });
  });
  const result = await cli.run(["status"], {
    sandboxFile: { read: async () => "12345678-0000\n", write: async () => {} },
  });
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.out).id).toBe(first);
});

test("launch saves the new sandbox ID in the invocation directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "armada-current-"));
  try {
    const cli = fixture(async () => Response.json({ sandbox: { id: first, status: "ready" } }));
    const result = await cli.run(["launch", "web", "--provider", "modal", "--agent", "codex", "--json"], {
      sandboxFile: currentSandboxFile(cwd),
    });
    expect(result.exit).toBe(0);
    expect(await readFile(join(cwd, ".armada/sandbox"), "utf8")).toBe(`${first}\n`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("non-TTY sandbox list uses JSON without an explicit flag", async () => {
  const cli = fixture(async () => Response.json({ sandboxes: [] }));
  const result = await cli.run(["list"], { stdoutIsTTY: false });
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.out)).toEqual({ sandboxes: [] });
});

test("machine failures end with one JSON line with code, message and hint", async () => {
  const cli = fixture(async () => {
    throw new Error("unexpected fetch");
  });
  const result = await cli.run(["status", "--bad-option"], { stdoutIsTTY: false });
  expect(result.exit).toBe(2);
  expect(result.out).toBe("");
  expect(result.err.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.err)).toEqual({
    error: {
      code: "invalid_config",
      message: "Unknown option '--bad-option'.",
      hint: "Next step: run armada status --help.",
    },
  });
});

test("a symlink cannot select a sandbox from outside the invocation directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "armada-current-"));
  try {
    await mkdir(join(cwd, ".armada"));
    await writeFile(join(cwd, "outside-selection"), first);
    await symlink(join(cwd, "outside-selection"), join(cwd, ".armada/sandbox"));
    const cli = fixture(async () => {
      throw new Error("unexpected fetch");
    });
    const result = await cli.run(["status", "--json"], { sandboxFile: currentSandboxFile(cwd) });
    expect(result.exit).toBe(2);
    expect(JSON.parse(result.err).error.message).toContain("Could not read .armada/sandbox");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
