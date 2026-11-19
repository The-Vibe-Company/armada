import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postDeploySmoke } from "./post-deploy-smoke.ts";
import deadlines from "./smoke-deadlines.json";

const ownedWorker = "12345678-1234-1234-1234-123456789abc";
const origin = "https://armada-mcp-staging.up.railway.app";
type Fault =
  | "none"
  | "never"
  | "late_ready"
  | "late_stop_metadata"
  | "reason"
  | "early"
  | "failed"
  | "failed_unconfirmed"
  | "deadline"
  | "changed"
  | "physical"
  | "lost_launch"
  | "recovered_launch"
  | "late_launch"
  | "unreadable_launch"
  | "missing_launch_id"
  | "malformed_launch_id"
  | "invalid_launch_receipt"
  | "cleanup_lost"
  | "cleanup_failed"
  | "ttl"
  | "list_missing"
  | "list_identity";
function fixture(provider: "modal", fault: Fault = "none") {
  let clock = 1_800_000_000_000;
  let expiry = clock + 180_000;
  let manualStop = false;
  let lookups = 0;
  let statusCalls = 0;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const reports: Record<string, unknown>[] = [];
  const io = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    out: (line: string) => {
      if (line !== "boat: not part of the release gate") reports.push(JSON.parse(line));
    },
    fetch: async (url: string, init: RequestInit) => {
      expect(new URL(url).origin).toBe(origin);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer canary-token");
      const path = new URL(url).pathname.replace("/api/v1/", "");
      if (init.method === "DELETE" && path === `sandboxes/${ownedWorker}`) {
        return Response.json({ id: ownedWorker, status: "deleted" });
      }
      const body = JSON.parse(String(init.body));
      calls.push({ path, body });
      if (path === "sandbox/launch") {
        expect(body.ttlSeconds).toBe(180);
        expect(body.skipSkillDefaults).toBe(true);
        expect(body.prompt).toBeUndefined();
        expect(body.connections).toEqual([]);
        expiry = clock + (fault === "deadline" ? 3600_000 : 180_000);
        clock += 2000;
        if (fault === "lost_launch" || fault === "recovered_launch" || fault === "late_launch") {
          clock += 120_000;
          expiry = clock + 180_000;
          throw new DOMException("secret transport detail", "TimeoutError");
        }
        if (fault === "unreadable_launch") return new Response("{", { status: 200 });
        return Response.json({
          sandbox:
            fault === "missing_launch_id"
              ? { id: "" }
              : { id: fault === "malformed_launch_id" ? "bad-id" : ownedWorker, provider },
          ...(fault === "invalid_launch_receipt" ? { promptId: "unexpected" } : {}),
        });
      }
      if (path === "sandbox/list") {
        expect(body.owner).toBe("me");
        if (body.externalRef !== undefined) {
          const launch = calls.find((call) => call.path === "sandbox/launch");
          expect(body.externalRef).toBe(launch?.body.idempotencyKey);
          expect(body.org).toBe("org");
          expect(body.externalRef).toBe(launch?.body.externalRef);
          lookups++;
          if (fault === "late_launch") clock += 120_001;
          const found =
            fault === "late_launch" ||
            fault === "unreadable_launch" ||
            fault === "missing_launch_id" ||
            fault === "malformed_launch_id" ||
            (fault === "recovered_launch" && lookups > 1);
          return Response.json({
            sandboxes: found
              ? [
                  {
                    id: ownedWorker,
                    provider,
                    externalRef: body.externalRef,
                    status: lookups === 2 ? "starting" : "ready",
                  },
                ]
              : [],
          });
        }
        expect(body.harness).toBe("codex");
        if (body.page === 1) return Response.json({ sandboxes: [], page: 1, hasMore: true, nextPage: 2 });
        const stopped = manualStop || clock >= expiry || (fault === "early" && statusCalls > 2);
        if (fault === "late_stop_metadata" && stopped && !manualStop) clock += deadlines.expiry_as_stop;
        return Response.json({
          sandboxes:
            fault === "list_missing"
              ? []
              : [
                  {
                    id: ownedWorker,
                    provider: fault === "list_identity" ? "wrong" : provider,
                    harness: "codex",
                    status:
                      ["failed", "failed_unconfirmed"].includes(fault) && manualStop
                        ? "failed"
                        : stopped
                          ? "stopped"
                          : "ready",
                    effectiveTtlSeconds: fault === "ttl" ? 3600 : 180,
                    stoppedAt: stopped && fault !== "failed_unconfirmed" ? new Date(clock).toISOString() : null,
                    expiresAt: new Date(expiry).toISOString(),
                  },
                ],
          page: 2,
          hasMore: false,
          nextPage: null,
        });
      }
      expect(body.id).toBe(ownedWorker);
      if (path === "sandbox/stop") {
        if (fault === "cleanup_failed") throw new Error("secret stop detail");
        manualStop = true;
        if (fault === "cleanup_lost") throw new Error("secret lost acknowledgement");
        return Response.json({ status: "stopping" });
      }
      if (path === "sandbox/status") {
        statusCalls++;
        if (fault === "late_ready" && statusCalls === 2) clock += deadlines.expiry_ready;
        const due = clock >= expiry;
        const naturallyStopped = due && !["never", "cleanup_lost", "cleanup_failed"].includes(fault);
        const early = fault === "early" && statusCalls > 2;
        const stopped = manualStop || naturallyStopped || early;
        const status =
          ["failed", "failed_unconfirmed"].includes(fault) && statusCalls > 2
            ? "failed"
            : stopped
              ? "stopped"
              : statusCalls === 1
                ? "starting"
                : "ready";
        return Response.json({
          id: ownedWorker,
          status,
          providerState: status === "failed" ? null : stopped && fault !== "physical" ? "stopped" : "active",
          statusReason: fault === "reason" ? "other" : "expired",
          expiresAt: new Date(expiry + (fault === "changed" && statusCalls > 2 ? 1000 : 0)).toISOString(),
        });
      }
      throw new Error("Unexpected API path");
    },
  };
  const env = {
    ARMADA_URL: origin,
    ARMADA_TOKEN: "canary-token",
    ARMADA_SMOKE: "create_real_compute",
    ARMADA_SMOKE_CASES: JSON.stringify([
      {
        provider,
        harness: "codex",
        org: "org",
        golden: "smoke",
        repo: "/home/user/repo",
        model: "model",
        modelAccountId: "account",
      },
    ]),
  };
  return { calls, reports, io, env };
}

test("Modal expires through the ordinary stop lane without a manual stop or model turn", async () => {
  const provider = "modal";
  const fake = fixture(provider);
  expect(await postDeploySmoke(fake.env, ["--expiry"], fake.io)).toBe(true);
  expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
  expect(fake.calls.some((call) => ["sandbox/stop", "sandbox/send"].includes(call.path))).toBe(false);
  for (const step of ["expiry_launch", "expiry_ready", "expiry_deadline", "expiry_as_stop"])
    expect(fake.reports).toContainEqual({ case: 0, lane: "expiry", step, pass: true, elapsedMs: expect.any(Number) });
  expect(fake.reports).toContainEqual({
    case: 0,
    lane: "expiry",
    step: "expiry_time_to_ready",
    pass: true,
    provider,
    harness: "codex",
    elapsedMs: 3000,
  });
  expect(fake.reports.find((line) => line.step === "expiry_cleanup_summary")).toMatchObject({
    pass: true,
    leftoverSandboxIds: [],
    launchOutcomeUnknown: false,
  });
});

test.each([
  ["late_ready", "expiry_ready"],
  ["late_stop_metadata", "expiry_as_stop"],
] as const)("expiry rejects evidence outside the measured budget: %s", async (fault, step) => {
  const fake = fixture("modal", fault);
  expect(await postDeploySmoke(fake.env, ["--expiry"], fake.io)).toBe(false);
  expect(fake.reports.find((line) => line.step === step)).toMatchObject({
    pass: false,
    code: "poll_limit_exceeded",
  });
  expect(fake.reports.find((line) => line.step === "expiry_cleanup_summary")).toMatchObject({
    pass: true,
    leftoverSandboxIds: [],
  });
});

test("expiry false receipts and timeouts fail closed; cleanup cannot turn a manual stop into proof", async () => {
  for (const fault of [
    "never",
    "reason",
    "early",
    "failed",
    "failed_unconfirmed",
    "deadline",
    "changed",
    "physical",
    "cleanup_lost",
    "cleanup_failed",
    "ttl",
    "list_missing",
    "list_identity",
  ] as const) {
    const fake = fixture("modal", fault);
    expect(await postDeploySmoke(fake.env, ["--expiry"], fake.io)).toBe(false);
    expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(1);
    expect(fake.calls.length).toBeLessThan(500);
    expect(fake.reports.some((line) => line.pass === false)).toBe(true);
    if (fault === "never") {
      expect(fake.reports.find((line) => line.step === "expiry_as_stop")).toMatchObject({
        pass: false,
        elapsedMs: deadlines.expiry_as_stop,
      });
    }
    const cleanup = fake.reports.find((line) => line.step === "expiry_cleanup_summary");
    expect(cleanup?.pass).toBe(!["physical", "cleanup_failed", "failed_unconfirmed"].includes(fault));
    expect(cleanup?.leftoverSandboxIds).toEqual(
      ["physical", "cleanup_failed", "failed_unconfirmed"].includes(fault) ? [ownedWorker] : [],
    );
    expect(JSON.stringify(fake.reports)).not.toContain("secret");
  }
});

test("ambiguous expiry launch is not replayed and retained IDs still get cleanup after invalid launch receipt", async () => {
  for (const fault of ["lost_launch", "invalid_launch_receipt"] as const) {
    const fake = fixture("modal", fault);
    expect(await postDeploySmoke(fake.env, ["--expiry"], fake.io)).toBe(false);
    expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
    const summary = fake.reports.find((line) => line.step === "expiry_cleanup_summary");
    expect(summary?.launchOutcomeUnknown).toBe(fault === "lost_launch");
    if (fault === "lost_launch") {
      const launch = fake.calls.find((call) => call.path === "sandbox/launch");
      expect(fake.reports.find((line) => line.step === "expiry_launch")).toMatchObject({
        elapsedMs: 122_000 + deadlines.expiry_launch,
        code: "request_failed",
        launchResponse: { requestKey: launch?.body.idempotencyKey },
      });
      expect(launch?.body.idempotencyKey).toEqual(expect.any(String));
      expect(JSON.stringify(fake.reports)).not.toContain("secret transport detail");
    }
    expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(fault === "lost_launch" ? 0 : 1);
  }
});

test("expiry admission refuses production and combinations that bypass its ordinary worker checks", async () => {
  for (const args of [["--expiry"], ["--expiry", "--templates-skills"]]) {
    const fake = fixture("modal");
    expect(
      await postDeploySmoke(
        { ...fake.env, ...(args.length === 1 ? { ARMADA_URL: "https://production.invalid" } : {}) },
        args,
        fake.io,
      ),
    ).toBe(false);
    expect(fake.calls).toHaveLength(0);
  }
});

test("expiry records launch latency when a timed-out request materializes after the first lookup", async () => {
  const fake = fixture("modal", "recovered_launch");
  expect(await postDeploySmoke(fake.env, ["--expiry"], fake.io)).toBe(true);
  expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
  expect(fake.reports.find((line) => line.step === "expiry_launch")).toMatchObject({
    pass: true,
    elapsedMs: 124_000,
  });
});

test("an expiry lookup that returns after the deadline provides a cleanup handle and leaves the launch failed", async () => {
  const fake = fixture("modal", "late_launch");
  expect(await postDeploySmoke(fake.env, ["--expiry"], fake.io)).toBe(false);
  expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toEqual([
    { path: "sandbox/stop", body: { org: "org", id: ownedWorker } },
  ]);
  expect(fake.reports.find((line) => line.step === "expiry_launch")?.pass).toBe(false);
});

test("expiry reconciles an unreadable successful launch response", async () => {
  const fake = fixture("modal", "unreadable_launch");
  expect(await postDeploySmoke(fake.env, ["--expiry"], fake.io)).toBe(true);
  expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
});

test.each(["missing_launch_id", "malformed_launch_id"] as const)(
  "an invalid launch receipt ID leaves the recovered staging journal clean (%s)",
  async (fault) => {
    const directory = mkdtempSync(join(tmpdir(), "expiry-smoke-"));
    try {
      const fake = fixture("modal", fault);
      const journal = join(directory, "sandboxes.json");
      expect(await postDeploySmoke({ ...fake.env, ARMADA_SMOKE_JOURNAL: journal }, ["--expiry"], fake.io)).toBe(true);
      expect(await Bun.file(journal).json()).toEqual([]);
      expect(fake.reports.find((line) => line.step === "smoke_cleanup_summary")).toMatchObject({
        pass: true,
        launchOutcomeUnknown: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
