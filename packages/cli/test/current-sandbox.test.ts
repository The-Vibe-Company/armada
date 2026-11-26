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
  const result = await cli.run(["info"], {
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
  const result = await cli.run(["info", "12345678", "--org", "team", "--json"]);
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
  const result = await cli.run(["info"], {
    sandboxFile: { read: async () => "12345678-0000\n", write: async () => {} },
  });
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.out).id).toBe(first);
});

test("new saves the new sandbox ID in the invocation directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "armada-current-"));
  try {
    const cli = fixture(async () => Response.json({ sandbox: { id: first, status: "ready" } }));
    const result = await cli.run(["new", "web", "--provider", "modal", "--agent", "codex", "--json"], {
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
  const result = await cli.run(["ls"], { stdoutIsTTY: false });
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.out)).toEqual({ sandboxes: [] });
});

test("machine failures end with one JSON line with code, message and hint", async () => {
  const cli = fixture(async () => {
    throw new Error("unexpected fetch");
  });
  const result = await cli.run(["info", "--bad-option"], { stdoutIsTTY: false });
  expect(result.exit).toBe(2);
  expect(result.out).toBe("");
  expect(result.err.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.err)).toEqual({
    error: {
      code: "invalid_config",
      message: "Unknown option '--bad-option'.",
      hint: "Next step: run armada info --help.",
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
    const result = await cli.run(["info", "--json"], { sandboxFile: currentSandboxFile(cwd) });
    expect(result.exit).toBe(2);
    expect(JSON.parse(result.err).error.message).toContain("Could not read .armada/sandbox");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("report accepts an outcome without an explicit sandbox ID", async () => {
  const cli = fixture(async (input, init) => {
    expect(new URL(String(input)).pathname).toBe("/api/v1/sandbox/report");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      id: first,
      prompt_id: second,
      outcome: { state: "blocked", reason: "Needs input" },
    });
    return Response.json({ accepted: true });
  }, first);
  const result = await cli.run(["report", "blocked", "--prompt-id", second, "--reason", "Needs input", "--json"]);
  expect(result.exit).toBe(0);
});

test("info --wait reads activity for the current sandbox and selected prompt", async () => {
  const receipt = { id: first, status: "running", prompt: null, settled: false, timedOut: true };
  const cli = fixture(async (input, init) => {
    expect(new URL(String(input)).pathname).toBe("/api/v1/sandbox/wait");
    expect(JSON.parse(String(init?.body))).toEqual({ id: first, org: "team", prompt_id: second, timeout_seconds: 0 });
    return Response.json(receipt);
  }, first);
  const result = await cli.run(["info", "--wait", "--org", "team", "--prompt-id", second, "--timeout", "0"]);
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.out)).toEqual(receipt);
});

test.each(
  [
    ["--wait", "--live"],
    ["--wait", "--setup"],
    ["--timeout", "0"],
  ].map((options) => ({ options })),
)("info rejects incompatible options $options before I/O", async ({ options }) => {
  const cli = fixture(async () => {
    throw new Error("unexpected fetch");
  }, first);
  expect((await cli.run(["info", ...options])).exit).toBe(2);
});

test("currentSandboxFile walks parent directories up to git root or home", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-walk-"));
  try {
    const repo = join(root, "repo");
    const nested = join(repo, "apps", "dashboard");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".armada"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(repo, ".armada", "sandbox"), `${first}\n`);
    expect((await currentSandboxFile(nested, root).read())?.trim()).toBe(first);

    const otherRepo = join(root, "other");
    const otherSub = join(otherRepo, "sub");
    await mkdir(join(root, ".armada"), { recursive: true });
    await writeFile(join(root, ".armada", "sandbox"), `${second}\n`);
    await mkdir(join(otherRepo, ".git"), { recursive: true });
    await mkdir(otherSub, { recursive: true });
    expect(await currentSandboxFile(otherSub, root).read()).toBeUndefined();

    const fakeHome = join(root, "home-dir");
    const homeSub = join(fakeHome, "work");
    await mkdir(homeSub, { recursive: true });
    expect(await currentSandboxFile(homeSub, fakeHome).read()).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
