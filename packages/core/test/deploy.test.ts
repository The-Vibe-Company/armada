import { expect, test } from "bun:test";
import { type DeployTarget, parseConfig } from "../src/config.ts";
import { type DeployInput, deployDetail, watchDeploy } from "../src/deploy.ts";
import { serveFleet } from "../src/fleet-api.ts";
import { memoryFleet } from "./memory-fleet.ts";
import { DEMO_PROJECT, DEMO_TOML, NOW } from "./support.ts";

const sha = "a".repeat(40),
  newer = "b".repeat(40);
const target: DeployTarget = {
  name: "api",
  branch: null,
  githubEnvironment: null,
  liveShaCommand: "version",
  smoke: "health",
  timeoutMinutes: 1,
  pauseOnFailure: true,
};

test("old, old, new deploy runs smoke once and records failure with last output", async () => {
  let now = 0,
    polls = 0,
    smokes = 0;
  const records: DeployInput[] = [];
  const result = await watchDeploy({
    target: { ...target, timeoutMinutes: 2 },
    sha,
    now: () => new Date(now),
    sleep: async (ms) => {
      now += ms;
    },
    live: async () => ({ sha: ++polls < 3 ? "c".repeat(40) : newer, state: "success", detail: "version output" }),
    includes: async (_base, head) => head === newer,
    smoke: async (live) => {
      expect(live).toBe(newer);
      smokes++;
      return { ok: false, detail: "health failed" };
    },
    record: async (r) => {
      records.push(r);
    },
  });
  expect(result).toBe("smoke-failed");
  expect(smokes).toBe(1);
  expect(now).toBe(60_000);
  expect(records.at(-1)).toMatchObject({ state: "smoke-failed", detail: "health failed", sha, liveSha: newer });
});

test("deadline records timeout without wall time, retaining last output", async () => {
  let now = 0;
  const records: DeployInput[] = [];
  await watchDeploy({
    target,
    sha,
    now: () => new Date(now),
    sleep: async (ms) => {
      now += ms;
    },
    live: async () => ({ sha: null, state: "pending", detail: "build still pending" }),
    includes: async () => false,
    smoke: async () => {
      throw new Error("must not smoke");
    },
    record: async (r) => {
      records.push(r);
    },
  });
  expect(now).toBe(60_000);
  expect(records.at(-1)).toMatchObject({ state: "timeout" });
  expect(records.at(-1)?.detail).toContain("build still pending");
});

test("failed descendants fail immediately; unrelated failures keep waiting; leases can be pending", async () => {
  for (const state of ["failure", "error"] as const) {
    const records: DeployInput[] = [];
    expect(
      await watchDeploy({
        target,
        sha,
        now: () => NOW,
        sleep: async () => {
          throw new Error("must not wait");
        },
        live: async () => ({ sha: newer, state, detail: "build failed" }),
        includes: async () => true,
        smoke: async () => {
          throw new Error("must not smoke");
        },
        record: async (r) => {
          records.push(r);
        },
      }),
    ).toBe("deploy-failed");
  }
  let now = 0,
    calls = 0;
  expect(
    await watchDeploy({
      target,
      sha,
      now: () => new Date(now),
      sleep: async (ms) => {
        now += ms;
      },
      live: async () => ({ sha, state: "success", detail: "live" }),
      includes: async () => false,
      smoke: async () => ({ ok: ++calls === 1 ? null : true, detail: "shared result" }),
      record: async () => {},
    }),
  ).toBe("healthy");
  expect(calls).toBe(2);
});

test("deploy detail keeps only 30 lines and 4 KiB of valid UTF-8", () => {
  expect(deployDetail(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")).split("\n")).toHaveLength(30);
  expect(new TextEncoder().encode(deployDetail("é".repeat(5000))).length).toBe(4096);
});

test("deploy targets validate live source, unique names, range and unknown keys", () => {
  expect(parseConfig(DEMO_TOML).deploy).toBeUndefined();
  const text = `${DEMO_TOML}\n[[deploy.target]]\nname = "api"\ngithub_environment = "production"\n`;
  expect(parseConfig(text).deploy?.targets[0]).toEqual({
    ...target,
    githubEnvironment: "production",
    liveShaCommand: null,
    smoke: null,
    timeoutMinutes: 20,
  });
  const withJobs = parseConfig(
    `${text}\n[jobs.eval]\nstart = "dispatch"\nstop = "cancel"\n[[ci.known_failure]]\ncheck = "test"\npattern = "cold start"\nticket = "DEMO-10"`,
  );
  expect(withJobs.deploy?.targets[0]?.name).toBe("api");
  expect(withJobs.jobs.eval?.start).toBe("dispatch");
  expect(withJobs.ci.knownFailures).toEqual([{ check: "test", pattern: "cold start", ticket: "DEMO-10" }]);
  for (const extra of [
    'live_sha_command = "version"',
    "timeout_minutes = 0",
    "timeout_minutes = 121",
    'pause_on_failure = "false"',
    "typo = true",
    '[[deploy.target]]\nname = "api"\nlive_sha_command = "version"',
  ])
    expect(() => parseConfig(`${text}\n${extra}`)).toThrow();
  expect(() => parseConfig(`${DEMO_TOML}\n[[deploy.target]]\nname = "api"`)).toThrow();
});

test("fleet failure creates one deploy hold and inbox item; worker deploy calls are forbidden", async () => {
  const store = memoryFleet();
  const input = { target: "api", sha, state: "timeout", detail: "last build lines", pauseOnFailure: true };
  const req = { op: "deploy/record", project: DEMO_PROJECT, caller: { kind: "organization" as const }, input };
  expect((await serveFleet(store, req, { now: () => NOW })).status).toBe(200);
  expect((await serveFleet(store, req, { now: () => NOW })).status).toBe(200);
  expect(await store.openHolds("widgets")).toHaveLength(1);
  const items = await store.openInboxItems({ project: "widgets", recipient: "coordinator" });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "deploy" });
  expect(items[0]?.body).toContain(sha);
  expect(items[0]?.body).toContain("last build lines");
  for (const op of ["deploy/record", "deploy/state"])
    expect(
      (await serveFleet(store, { ...req, op, caller: { kind: "worker", ticket: "DEMO-7" } }, { now: () => NOW }))
        .status,
    ).toBe(403);
});

test("GitHub deploy adapter reads exact environment and SHA comparison distinguishes ancestry", async () => {
  const { fetchLiveDeploy, fetchShaComparison } = await import("../src/github.ts");
  let calls = 0;
  const options = {
    token: "synthetic",
    repository: "acme/widgets",
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (String(url).endsWith("graphql")) {
        const body = JSON.parse(String(init?.body));
        expect(body.variables.environment).toBe("production");
        expect(body.query).not.toContain("Vercel");
        return Response.json({
          data: {
            repository: {
              deployments: {
                nodes: [{ commit: { oid: newer }, latestStatus: { state: "ERROR", description: "build failed" } }],
              },
            },
          },
        });
      }
      expect(String(url)).toContain(`/compare/${sha}...${newer}`);
      return Response.json({ status: "ahead" });
    },
  };
  expect(await fetchLiveDeploy({ ...options, environment: "production" })).toEqual({
    sha: newer,
    state: "error",
    detail: "production: error\nbuild failed",
  });
  expect(await fetchShaComparison({ ...options, base: sha, head: newer })).toBe(true);
  expect(calls).toBe(2);
  expect(
    await fetchShaComparison({
      ...options,
      fetch: async () => Response.json({ status: "diverged" }),
      base: sha,
      head: newer,
    }),
  ).toBe(false);
});

test("overlapping watcher finishes from a newer healthy deploy without polling or rerunning smoke", async () => {
  const records: DeployInput[] = [];
  expect(
    await watchDeploy({
      target,
      sha,
      now: () => NOW,
      sleep: async () => {
        throw new Error("must not wait");
      },
      healthy: async () => ({ sha: newer, detail: "smoke already verified" }),
      live: async () => {
        throw new Error("must not read hosting");
      },
      includes: async () => false,
      smoke: async () => {
        throw new Error("must not smoke");
      },
      record: async (r) => {
        records.push(r);
      },
    }),
  ).toBe("healthy");
  expect(records.at(-1)).toMatchObject({ state: "healthy", liveSha: newer });
});

test("transient shared-state and smoke lease errors retry until healthy or deadline", async () => {
  for (const recovers of [true, false]) {
    let now = 0,
      attempts = 0;
    const records: DeployInput[] = [];
    const state = await watchDeploy({
      target: { ...target, timeoutMinutes: 2 },
      sha,
      now: () => new Date(now),
      sleep: async (ms) => {
        now += ms;
      },
      healthy: async () => {
        throw new Error("temporary shared-state outage");
      },
      live: async () => ({ sha, state: "success", detail: "live" }),
      includes: async () => true,
      smoke: async () => {
        if (!recovers || ++attempts === 1) throw new Error("temporary lease outage");
        return { ok: true, detail: "health ok" };
      },
      record: async (input) => {
        records.push(input);
      },
    });
    expect(state).toBe(recovers ? "healthy" : "timeout");
    expect(now).toBe(recovers ? 30_000 : 120_000);
    expect(records.at(-1)?.state).toBe(state);
  }
});
