import { describe, expect, test } from "bun:test";
import { stageSmokeAdmission } from "./staging-smoke-admission";

const now = Date.parse("2026-11-13T12:00:00Z");
const env = { GH_REPO: "example/armada", GH_TOKEN: "test-token" };
const previousSha = "a".repeat(40);
const currentSha = "b".repeat(40);
const producer = {
  head_repository: { full_name: env.GH_REPO },
  head_branch: "main",
  event: "push",
  path: ".github/workflows/staging-gated-production.yml",
  conclusion: "failure",
};
function slot(minutesAgo: number) {
  return {
    expired: false,
    created_at: new Date(now - minutesAgo * 60_000).toISOString(),
    workflow_run: { id: 123, repository_id: 1, head_repository_id: 1, head_branch: "main", head_sha: previousSha },
  };
}
function harness(artifacts: unknown[] = [], run: unknown = producer) {
  const output: string[] = [];
  const requests: string[] = [];
  const io = {
    now: () => now,
    out: (message: string) => output.push(message),
    fetch: (async (url: string | URL | Request) => {
      const path = String(url);
      requests.push(path);
      if (path.endsWith("actions/artifacts?name=staging-full-smoke-slot&per_page=100")) {
        return Response.json({ artifacts });
      }
      if (path.endsWith("actions/runs/123")) return Response.json(run);
      throw new Error("Unexpected request");
    }) as typeof fetch,
  };
  return { io, output, requests };
}

describe("staging full-smoke admission", () => {
  // Owner-boundary coverage: a mistaken default/cutoff or success-only throttle would spend
  // compute on every main push. These contracts have no prior admission test owner.
  test.each([
    { minutes: 29.999, admitted: false },
    { minutes: 30, admitted: true },
    { minutes: 31, admitted: true },
  ])("default cadence cutoff: $minutes minutes (failed attempts count)", async ({ minutes, admitted }) => {
    const { io, output } = harness([slot(minutes)]);
    expect(await stageSmokeAdmission(env, io)).toBe(admitted);
    expect(output).toEqual(admitted ? [] : ["not-run(cadence)"]);
  });

  test("configured cadence uses the newest nonexpired same-repository main slot", async () => {
    const old = slot(40);
    const ignored = slot(1);
    const { io } = harness([
      old,
      { ...ignored, expired: true },
      { ...ignored, workflow_run: { ...ignored.workflow_run, head_repository_id: 2 } },
      { ...ignored, workflow_run: { ...ignored.workflow_run, head_branch: "feature" } },
      slot(10),
    ]);
    expect(await stageSmokeAdmission({ ...env, STAGING_SMOKE_INTERVAL_MINUTES: "15" }, io)).toBe(false);
  });

  test("no prior eligible slot admits the first attempt", async () => {
    const { io, requests } = harness();
    expect(await stageSmokeAdmission(env, io)).toBe(true);
    expect(requests).toHaveLength(1);
  });

  test("publishing releases bypass cadence without GitHub credentials or requests", async () => {
    const { io, requests } = harness([slot(1)]);
    expect(
      await stageSmokeAdmission({ SMOKE_RELEASE_GATE: "true", SMOKE_SCHEDULED: "true", GITHUB_SHA: "invalid" }, io),
    ).toBe(true);
    expect(requests).toEqual([]);
  });

  // Scheduled catch-up must cover a new quiet main tip without rebuilding an already attempted tip.
  test.each([
    { sha: previousSha, minutes: 31, admitted: false, reason: "not-run(already-attempted)" },
    { sha: previousSha.toUpperCase(), minutes: 1, admitted: false, reason: "not-run(already-attempted)" },
    { sha: currentSha, minutes: 31, admitted: true, reason: undefined },
    { sha: currentSha, minutes: 1, admitted: false, reason: "not-run(cadence)" },
  ])("scheduled catch-up for $sha at $minutes minutes", async ({ sha, minutes, admitted, reason }) => {
    const { io, output } = harness([slot(minutes)], { ...producer, event: "schedule" });
    expect(await stageSmokeAdmission({ ...env, SMOKE_SCHEDULED: "true", GITHUB_SHA: sha }, io)).toBe(admitted);
    expect(output).toEqual(reason ? [reason] : []);
  });

  test("scheduled catch-up admits a first attempt", async () => {
    const { io } = harness();
    expect(await stageSmokeAdmission({ ...env, SMOKE_SCHEDULED: "true", GITHUB_SHA: currentSha }, io)).toBe(true);
  });

  test.each([undefined, "", "a".repeat(39), "g".repeat(40)])(
    "rejects invalid scheduled current commit %j",
    async (sha) => {
      const { io, requests } = harness();
      await expect(stageSmokeAdmission({ ...env, SMOKE_SCHEDULED: "true", GITHUB_SHA: sha }, io)).rejects.toThrow(
        "Invalid staging smoke admission configuration",
      );
      expect(requests).toEqual([]);
    },
  );

  test.each([undefined, "", "a".repeat(39), "g".repeat(40)])(
    "rejects invalid scheduled slot commit %j",
    async (sha) => {
      const prior = slot(31);
      const { io, output } = harness([{ ...prior, workflow_run: { ...prior.workflow_run, head_sha: sha } }]);
      await expect(
        stageSmokeAdmission({ ...env, SMOKE_SCHEDULED: "true", GITHUB_SHA: currentSha }, io),
      ).rejects.toThrow("Unable to verify staging smoke admission evidence");
      expect(output).toEqual([]);
    },
  );

  // Config and provenance failures must fail the job, never masquerade as a successful skip.
  test.each(["", "0", "1441", "1.5", "-1", "NaN", " 30"])(
    "rejects invalid interval %j even for releases",
    async (interval) => {
      const { io, requests } = harness();
      await expect(
        stageSmokeAdmission({ SMOKE_RELEASE_GATE: "true", STAGING_SMOKE_INTERVAL_MINUTES: interval }, io),
      ).rejects.toThrow("Invalid staging smoke admission configuration");
      expect(requests).toEqual([]);
    },
  );

  test.each([{}, { GH_REPO: "example/armada" }, { ...env, GH_REPO: "../bad/repo" }])(
    "rejects missing or invalid GitHub configuration %j",
    async (config) => {
      const { io, requests } = harness();
      await expect(stageSmokeAdmission(config, io)).rejects.toThrow("Invalid staging smoke admission configuration");
      expect(requests).toEqual([]);
    },
  );

  test.each([
    { ...producer, head_repository: { full_name: "attacker/armada" } },
    { ...producer, head_branch: "feature" },
    { ...producer, event: "pull_request" },
    { ...producer, path: ".github/workflows/untrusted.yml" },
    null,
  ])("rejects untrusted artifact producers %#", async (run) => {
    const { io, output } = harness([slot(1)], run);
    await expect(stageSmokeAdmission(env, io)).rejects.toThrow("Unable to verify staging smoke admission evidence");
    expect(output).toEqual([]);
  });

  test("accepts manual main staging-workflow slots", async () => {
    const { io } = harness([slot(1)], {
      ...producer,
      event: "workflow_dispatch",
      path: ".github/workflows/post-deploy-smoke.yml",
    });
    expect(await stageSmokeAdmission(env, io)).toBe(false);
  });

  test.each(["status", "network", "malformed", "producer-api"])(
    "fails closed on %s without leaking evidence",
    async (failure) => {
      const { io, output } = harness([slot(1)]);
      const original = io.fetch;
      io.fetch = (async (...args: Parameters<typeof fetch>) => {
        if (failure === "network") throw new Error("private-token");
        if (failure === "malformed") return Response.json({ artifacts: [{ expired: false }] });
        if (failure === "status" || String(args[0]).includes("actions/runs")) {
          return new Response("private-response", { status: 403 });
        }
        return original(...args);
      }) as typeof fetch;
      await expect(stageSmokeAdmission(env, io)).rejects.toThrow("Unable to verify staging smoke admission evidence");
      expect(output).toEqual([]);
    },
  );
});
