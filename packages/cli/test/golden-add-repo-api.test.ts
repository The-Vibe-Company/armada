import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const token = "fixture-armada-token";
async function invoke(
  args: string[],
  reply: (path: string, body: Record<string, unknown>) => Response,
  config?: unknown,
) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let output = "",
    errors = "";
  const code = await run(
    ["golden", "update", "web", ...args],
    {
      out: (text) => {
        output += text;
      },
      err: (text) => {
        errors += text;
      },
    },
    {
      readFile: async () =>
        JSON.stringify(
          config ?? { repos: [{ url: "https://github.com/acme/new.git", branch: "main", dir: "new" }], init: [] },
        ),
      auth: {
        out: () => {},
        err: () => {},
        env: { ARMADA_TOKEN: token },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          const body = JSON.parse(String(init?.body));
          calls.push({ path, body });
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + token);
          return reply(path, body);
        },
      },
    },
  );
  return { code, calls, output, errors };
}

test("--add-repo sends only additions to its dedicated route and never reconstructs/replaces stored config", async () => {
  const result = await invoke(
    ["--add-repo", "https://github.com/acme/new.git@develop", "--provider", "boat", "--org", "org", "--timeout", "0"],
    () =>
      Response.json({ jobId: "job", state: "queued", phase: "queued", errorCode: null, result: null }, { status: 202 }),
  );
  expect(result.code).toBe(0);
  expect(result.calls).toEqual([
    {
      path: "/api/v1/golden/update-add-repos",
      body: {
        name: "web",
        addRepos: ["https://github.com/acme/new.git@develop"],
        provider: "boat",
        org: "org",
        idempotencyKey: expect.any(String),
      },
    },
  ]);
});

test.each(["--repo", "--config", "--init", "--setup"])("--add-repo refuses mixing %s before requests", async (flag) => {
  const result = await invoke(["--add-repo", "https://github.com/acme/new.git", flag, "value"], () => {
    throw new Error("No request expected");
  });
  expect(result.code).toBe(2);
  expect(result.errors).toContain("Do not combine");
  expect(result.calls).toEqual([]);
});

test.each([
  [404, "unknown_route", "Unknown route.", "--add-repo. Upgrade the Armada server"],
  [
    409,
    "conflict",
    "Golden exists on boat and modal. Pass --provider boat or modal.",
    "Repeat the update with --provider",
  ],
  [409, "conflict", "Golden capacity or binding is unavailable or busy.", "administrator must distinguish"],
] as const)(
  "update refusal preserves server code and gives a remedy (%s, %s)",
  async (status, code, message, remedy) => {
    const result = await invoke(["--add-repo", "https://github.com/acme/new.git", "--json"], () =>
      Response.json({ error: { code, message } }, { status }),
    );
    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(1); // No replacement fallback or blind retries.
    const json = JSON.parse(result.errors.trim().split("\n").at(-1)!);
    expect(json.error.code).toBe(status === 404 ? "unavailable" : code);
    expect(json.error.message).toContain(remedy);
  },
);

test.each(["--repo", "--config"])(
  "replacement through %s requires explicit consent before any request",
  async (source) => {
    const result = await invoke([source, "https://github.com/acme/new.git"], () => {
      throw new Error("No mutation allowed without consent");
    });
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
    expect(result.errors).toContain("--replace");
    expect(result.errors).toContain("--add-repo");
  },
);

test("append and replacement cannot be requested together", async () => {
  const result = await invoke(["--add-repo", "https://github.com/acme/new.git", "--replace"], () => {
    throw new Error("No mutation allowed with contradictory intent");
  });
  expect(result.code).toBe(2);
  expect(result.calls).toEqual([]);
  expect(result.errors).toContain("choose append or replacement");
});

test("--repo is explicitly warned as replacement rather than silently advertised as additive", async () => {
  const result = await invoke(["--replace", "--repo", "https://github.com/acme/new.git", "--timeout", "0"], () =>
    Response.json({ jobId: "job", state: "queued", phase: "queued", errorCode: null, result: null }, { status: 202 }),
  );
  expect(result.code).toBe(0);
  expect(result.calls[0]?.path).toBe("/api/v1/golden/update");
  expect(result.errors).toContain("replaces ALL stored repositories and init commands");
});

test("legacy synchronous update reply is treated as version-skew/unknown outcome, never polled as undefined", async () => {
  const result = await invoke(["--replace", "--repo", "https://github.com/acme/new.git", "--json"], () =>
    Response.json({ name: "web", visibility: "org", snapshot: "saved" }),
  );
  expect(result.code).toBe(1);
  expect(result.calls).toHaveLength(1);
  expect(result.errors).toContain("did not return a durable build receipt");
  expect(result.errors).toContain("inspect snapshot list before retrying");
  expect(result.errors).not.toContain("Build undefined");
});

test.each([true, false])(
  "build-find sends a scoped read-only lookup and does not imply capacity is free (found=%s)",
  async (found) => {
    let output = "";
    const calls: { path: string; body: unknown }[] = [];
    const code = await run(
      ["golden", "build-find", "web", "--provider", "boat", "--org", "org"],
      {
        out: (text) => {
          output += text;
        },
        err: () => {},
      },
      {
        auth: {
          out: () => {},
          err: () => {},
          env: { ARMADA_TOKEN: token },
          session: memorySessionStore(),
          now: () => new Date(),
          open: () => {},
          fetch: async (input, init) => {
            calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
            return Response.json({
              build: found
                ? {
                    jobId: "job",
                    state: "recovery_required",
                    phase: "snapshot",
                    errorCode: "build_failed",
                    failureReason: null,
                    result: null,
                  }
                : null,
            });
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([{ path: "/api/v1/golden/build/find", body: { name: "web", provider: "boat", org: "org" } }]);
    expect(output).toContain(
      found ? "Build job: recovery_required (snapshot)" : "A reservation may still need administrator investigation",
    );
  },
);

test("update --config retains the explicit per-repository history and every other entry", async () => {
  const config = {
    repos: [
      { url: "https://github.com/acme/armada.git", branch: "main", dir: "armada", history: "shallow" },
      { url: "https://github.com/acme/private.git", branch: "main", dir: "private" },
    ],
    init: ["bun install"],
  };
  const result = await invoke(
    ["--config", "golden.json", "--replace", "--timeout", "0"],
    () =>
      Response.json({ jobId: "job", state: "queued", phase: "queued", errorCode: null, result: null }, { status: 202 }),
    config,
  );
  expect(result.code, result.errors).toBe(0);
  expect(result.calls[0]?.body.config).toEqual(config);
});
