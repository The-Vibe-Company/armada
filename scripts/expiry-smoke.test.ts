import { expect, test } from "bun:test";
import { postDeploySmoke } from "./post-deploy-smoke.ts";

const origin = "https://armada-mcp-staging.up.railway.app";
type Fault =
  | "none"
  | "never"
  | "reason"
  | "early"
  | "failed"
  | "deadline"
  | "changed"
  | "physical"
  | "lost_launch"
  | "wrong_provider"
  | "cleanup_lost"
  | "cleanup_failed";
function fixture(provider: "boat" | "modal", fault: Fault = "none") {
  let clock = 1_800_000_000_000;
  let expiry = clock + 180_000;
  let manualStop = false;
  let statusCalls = 0;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const reports: Record<string, unknown>[] = [];
  const io = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    out: (line: string) => reports.push(JSON.parse(line)),
    fetch: async (url: string, init: RequestInit) => {
      expect(new URL(url).origin).toBe(origin);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer canary-token");
      const path = new URL(url).pathname.replace("/api/v1/", "");
      const body = JSON.parse(String(init.body));
      calls.push({ path, body });
      if (path === "sandbox/launch") {
        expect(body.ttlSeconds).toBe(180);
        expect(body.skipSkillDefaults).toBe(true);
        expect(body.prompt).toBeUndefined();
        expect(body.connections).toEqual([]);
        expiry = clock + (fault === "deadline" ? 3600_000 : 180_000);
        clock += 2000;
        if (fault === "lost_launch") throw new Error("secret transport detail");
        return Response.json({
          sandbox: { id: "owned-worker", provider: fault === "wrong_provider" ? "wrong" : provider },
        });
      }
      expect(body.id).toBe("owned-worker");
      if (path === "sandbox/stop") {
        if (fault === "cleanup_failed") throw new Error("secret stop detail");
        manualStop = true;
        if (fault === "cleanup_lost") throw new Error("secret lost acknowledgement");
        return Response.json({ status: "stopping" });
      }
      if (path === "sandbox/status") {
        statusCalls++;
        const due = clock >= expiry;
        const naturallyStopped = due && !["never", "cleanup_lost", "cleanup_failed"].includes(fault);
        const early = fault === "early" && statusCalls > 2;
        const stopped = manualStop || naturallyStopped || early;
        const status =
          !manualStop && fault === "failed" && statusCalls > 2
            ? "failed"
            : stopped
              ? "stopped"
              : statusCalls === 1
                ? "starting"
                : "ready";
        return Response.json({
          id: "owned-worker",
          effectiveTtlSeconds: 180,
          provider,
          status,
          providerState: stopped && fault !== "physical" ? (provider === "boat" ? "archived" : "stopped") : "active",
          statusReason: fault === "reason" ? "other" : "expired",
          stoppedAt: stopped ? new Date(clock).toISOString() : null,
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

test("each provider expires through the ordinary stop lane without a manual stop or model turn", async () => {
  for (const provider of ["boat", "modal"] as const) {
    const fake = fixture(provider);
    expect(await postDeploySmoke(fake.env, ["--expiry"], fake.io)).toBe(true);
    expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
    expect(fake.calls.some((call) => ["sandbox/stop", "sandbox/send"].includes(call.path))).toBe(false);
    for (const step of ["expiry_launch", "expiry_ready", "expiry_deadline", "expiry_as_stop"])
      expect(fake.reports).toContainEqual({ case: 0, step, pass: true });
    expect(fake.reports).toContainEqual({
      case: 0,
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
  }
});

test("expiry false receipts and timeouts fail closed; cleanup cannot turn a manual stop into proof", async () => {
  for (const fault of [
    "never",
    "reason",
    "early",
    "failed",
    "deadline",
    "changed",
    "physical",
    "cleanup_lost",
    "cleanup_failed",
  ] as const) {
    const fake = fixture("boat", fault);
    expect(await postDeploySmoke(fake.env, ["--expiry"], fake.io)).toBe(false);
    expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(1);
    expect(fake.calls.length).toBeLessThan(500);
    expect(fake.reports.some((line) => line.pass === false)).toBe(true);
    const cleanup = fake.reports.find((line) => line.step === "expiry_cleanup_summary");
    expect(cleanup?.pass).toBe(!["physical", "cleanup_failed"].includes(fault));
    expect(cleanup?.leftoverSandboxIds).toEqual(["physical", "cleanup_failed"].includes(fault) ? ["owned-worker"] : []);
    expect(JSON.stringify(fake.reports)).not.toContain("secret");
  }
});

test("ambiguous expiry launch is not replayed and retained IDs still get cleanup after invalid launch receipt", async () => {
  for (const fault of ["lost_launch", "wrong_provider"] as const) {
    const fake = fixture("modal", fault);
    expect(await postDeploySmoke(fake.env, ["--expiry"], fake.io)).toBe(false);
    expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
    const summary = fake.reports.find((line) => line.step === "expiry_cleanup_summary");
    expect(summary?.launchOutcomeUnknown).toBe(fault === "lost_launch");
    expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(fault === "lost_launch" ? 0 : 1);
  }
});

test("expiry admission refuses production and combinations that bypass its ordinary worker checks", async () => {
  for (const args of [["--expiry"], ["--expiry", "--templates-skills"], ["--expiry", "--orchestrator"]]) {
    const fake = fixture("boat");
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
