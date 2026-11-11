import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const token = "armada_sk_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12";
test("golden create maps positional config to API with token-only auth", async () => {
  const calls: Request[] = [];
  let out = "";
  let warnings = "";
  const code = await run(
    [
      "golden",
      "create",
      "web",
      "--repo",
      "https://github.com/acme/web.git@feature/login",
      "--repo",
      "git@github.com:acme/api.git@release/x",
      "--init",
      "pnpm install",
      "--private",
      "--org",
      "team",
    ],
    { out: (t) => (out += t), err: (t) => (warnings += t) },
    {
      auth: {
        out: () => undefined,
        err: () => undefined,
        env: { ARMADA_TOKEN: token },
        fetch: async (input, init) => {
          const r = input instanceof Request ? input : new Request(String(input), init);
          calls.push(r);
          return Response.json({
            jobId: crypto.randomUUID(),
            state: "succeeded",
            phase: "complete",
            errorCode: null,
            result: {
              name: "web",
              visibility: "private",
              snapshot: "golden-bx",
              warnings: ["skillpack_download_unavailable"],
            },
          });
        },
        now: () => new Date(),
        open: () => undefined,
        session: memorySessionStore(),
      },
    },
  );
  expect(code).toBe(0);
  expect(out).toContain("Saved snapshot: golden-bx");
  expect(warnings).toContain("Warning: skillpack_download_unavailable");
  expect(warnings).toContain("allow GitHub release egress");
  expect(calls[0]?.url).toBe("https://armada.thevibecompany.co/api/v1/golden/create");
  expect(await calls[0]?.json()).toMatchObject({
    name: "web",
    private: true,
    org: "team",
    config: {
      init: ["pnpm install"],
      repos: [
        { branch: "feature/login", dir: "web" },
        { branch: "release/x", dir: "api" },
      ],
    },
  });
});

test("token-only golden create prints an actionable API conflict and exits nonzero", async () => {
  const message =
    "Golden capacity or binding is unavailable or busy. Use an existing golden you can access, retry after any active build finishes, or ask an administrator to check the binding.";
  let errorOutput = "";
  let output = "";
  let requests = 0;
  const code = await run(
    ["golden", "create", "quota-probe", "--repo", "https://github.com/acme/web", "--json"],
    {
      out: (text) => {
        output += text;
      },
      err: (text) => {
        errorOutput += text;
      },
    },
    {
      auth: {
        out: () => {},
        err: () => {},
        env: { ARMADA_TOKEN: token },
        fetch: async () => {
          requests++;
          return Response.json({ error: { code: "conflict", message } }, { status: 409 });
        },
        now: () => new Date(),
        open: () => {},
        session: memorySessionStore(),
      },
    },
  );
  expect(code).toBe(1);
  expect(errorOutput).toContain(message);
  expect(errorOutput).not.toContain(token);
  expect(output).toBe("");
  expect(requests).toBe(1);
});

for (const outcome of ["succeeded", "failed", "billing", "recovery", "disconnected"] as const) {
  test("golden polls its admitted job without replaying admission: " + outcome, async () => {
    const requests: { path: string; body: Record<string, unknown>; init: RequestInit | undefined }[] = [];
    const jobId = crypto.randomUUID();
    let error = "";
    let output = "";
    let sleeps = 0;
    const code = await run(
      [
        "golden",
        "create",
        "web",
        "--repo",
        "https://github.com/acme/web.git",
        "--idempotency-key",
        "stable-admission-key",
      ],
      {
        out: (text) => {
          output += text;
        },
        err: (text) => {
          error += text;
        },
      },
      {
        sleep: async () => {
          sleeps++;
        },
        auth: {
          out: () => {},
          err: () => {},
          env: { ARMADA_TOKEN: token },
          session: memorySessionStore(),
          now: () => new Date(),
          open: () => {},
          fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            requests.push({ path, body: JSON.parse(String(init?.body)), init });
            if (path.endsWith("/create"))
              return Response.json(
                { jobId, state: "queued", phase: "queued", errorCode: null, result: null },
                { status: 202 },
              );
            if (outcome === "disconnected") throw new Error("transport failed");
            return Response.json({
              jobId,
              provider: "boat",
              failureReason: outcome === "billing" || outcome === "recovery" ? "provider_payment_required" : null,
              state: outcome === "billing" ? "failed" : outcome === "recovery" ? "recovery_required" : outcome,
              phase: outcome === "failed" ? "secret_scan" : "complete",
              errorCode: outcome === "failed" ? "build_failed" : null,
              result: outcome === "succeeded" ? { name: "web", visibility: "org", snapshot: "new-snapshot" } : null,
            });
          },
        },
      },
    );
    expect(requests.map((r) => r.path)).toEqual(["/api/v1/golden/create", "/api/v1/golden/build/status"]);
    expect(requests[0]?.body.idempotencyKey).toBe("stable-admission-key");
    expect(requests[1]?.body).toEqual({ jobId });
    expect(sleeps).toBe(1);
    for (const r of requests) expect(r.init).toMatchObject({ timeout: false, signal: expect.any(AbortSignal) });
    expect(output).toContain(jobId);
    expect(code).toBe(outcome === "succeeded" ? 0 : 1);
    if (outcome === "failed") expect(error).toContain("build_failed");
    if (outcome === "disconnected") expect(error).toContain("do not resubmit");
    if (outcome === "billing")
      expect(error.split("\n").find((line) => line.startsWith("armada: Build"))).toBe(
        `armada: Build ${jobId}: failed (The Boat account cannot create machines: add billing or credits on Boat, then retry.).`,
      );
    if (outcome === "recovery") {
      expect(error.split("\n").find((line) => line.startsWith("armada: Build"))).toBe(
        `armada: Build ${jobId}: recovery_required (Recovery required; capacity is still held. Reconcile the original build before retrying.).`,
      );
      expect(error).not.toContain("then retry.");
    }
  });
}

for (const state of ["succeeded", "queued"] as const) {
  test(`golden JSON output is one complete document after durable admission: ${state}`, async () => {
    const result = { name: "web", visibility: "private", snapshot: "golden-bx" };
    const job = {
      jobId: "11111111-1111-4111-8111-111111111111",
      state,
      phase: state === "succeeded" ? "complete" : "queued",
      errorCode: null,
      result: state === "succeeded" ? result : null,
    };
    const paths: string[] = [];
    let output = "";
    const code = await run(
      ["golden", "create", "web", "--repo", "https://github.com/acme/web.git", "--timeout", "0", "--json"],
      {
        out: (text) => {
          output += text;
        },
        err: () => {},
      },
      {
        sleep: async () => {
          throw new Error("Admission-only mode must not poll.");
        },
        auth: {
          out: () => {},
          err: () => {},
          env: { ARMADA_TOKEN: token },
          session: memorySessionStore(),
          now: () => new Date(),
          open: () => {},
          fetch: async (input) => {
            paths.push(new URL(String(input)).pathname);
            return Response.json(job, { status: 202 });
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(paths).toEqual(["/api/v1/golden/create"]);
    expect(JSON.parse(output)).toEqual(state === "succeeded" ? result : job);
    expect(output).not.toContain(token);
  });
}
