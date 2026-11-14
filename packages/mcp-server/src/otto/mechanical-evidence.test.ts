import { expect, test } from "bun:test";
import { mechanicalEvidence } from "./mechanical-evidence.ts";
import type { OwnershipFact } from "./ownership.ts";

test("mechanical evidence is exact-head, fresh, policy-bound and never upgrades absence of failure to success", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  const head = "a".repeat(40);
  const fact = (kind: string, value: string, evidence: Record<string, unknown>, at = now.toISOString()) =>
    ({
      id: kind,
      subject: "pr:12",
      kind,
      value,
      evidence,
      observed_at: at,
      completeness: "complete",
    }) as OwnershipFact;
  const pr = fact("pr.open", "true", { head: { sha: head } });
  const failure = fact("pr.work.required_check", "true", { headSha: head, policyObserved: true });
  expect(mechanicalEvidence("owner/repo", 12, [pr, failure], now).requiredChecks).toBe("failure");
  for (const invalid of [
    { ...failure, evidence: { headSha: "b".repeat(40), policyObserved: true } },
    { ...failure, evidence: { headSha: head, policyObserved: false } },
    { ...failure, completeness: "partial" as const },
    { ...failure, value: "false" as const },
    { ...failure, observed_at: "2026-11-14T11:00:00Z" },
  ])
    expect(mechanicalEvidence("owner/repo", 12, [pr, invalid], now).requiredChecks).toBe("unknown");
  const empty = mechanicalEvidence("owner/repo", 12, [], now);
  expect([empty.headSha, empty.requiredChecks, empty.mergeState, empty.deployment]).toEqual([
    null,
    "unknown",
    "unknown",
    "unknown",
  ]);
  expect(
    mechanicalEvidence("owner/repo", 12, [pr, fact("pr.work.conflict", "false", { headSha: head })], now).mergeState,
  ).toBe("mergeable");
});

test("live inspection proves required checks on a stable head and fails closed on denied policy or head movement", async () => {
  const { inspectMechanicalEvidence } = await import("./mechanical-evidence.ts");
  const head = "a".repeat(40);
  for (const mode of ["success", "denied", "changed", "duplicate", "no-requirements"]) {
    let pulls = 0;
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pulls/"))
        return Response.json({
          head: { sha: mode === "changed" && pulls++ > 0 ? "b".repeat(40) : head },
          base: { ref: "main" },
          merged: true,
          mergeable: true,
        });
      if (url.includes("/protection/"))
        return mode === "denied"
          ? new Response(null, { status: 403 })
          : mode === "duplicate"
            ? Response.json({ checks: [{ context: "unit", app_id: 1 }] })
            : new Response(null, { status: 404 });
      if (url.includes("/rules/"))
        return Response.json(
          mode === "duplicate"
            ? [
                {
                  type: "required_status_checks",
                  parameters: { required_status_checks: [{ context: "unit", integration_id: 2 }] },
                },
              ]
            : mode === "no-requirements"
              ? []
              : [
                  {
                    type: "required_status_checks",
                    parameters: { required_status_checks: [{ context: "unit", integration_id: 1 }] },
                  },
                ],
        );
      if (url.includes("/check-runs"))
        return Response.json({
          total_count: mode === "duplicate" ? 2 : 1,
          check_runs: [
            ...(mode === "duplicate"
              ? [{ name: "unit", app: { id: 2 }, head_sha: head, status: "completed", conclusion: "success" }]
              : []),
            {
              name: "unit",
              app: { id: 1 },
              head_sha: head,
              status: "completed",
              conclusion: mode === "duplicate" ? "failure" : "success",
            },
          ],
        });
      return Response.json({ sha: head, total_count: 0, statuses: [] });
    }) as typeof fetch;
    const proof = await inspectMechanicalEvidence("owner/repo", 12, "observer_placeholder", fetcher);
    expect(proof.requiredChecks).toBe(mode === "success" ? "success" : mode === "duplicate" ? "failure" : "unknown");
    if (mode === "duplicate") expect(proof.checks).toEqual([{ name: "unit", state: "failure" }]);
    if (mode === "success") {
      expect(proof.merged).toBe(true);
      expect(proof.checks).toEqual([{ name: "unit", state: "success" }]);
    }
  }
});
