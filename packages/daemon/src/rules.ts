import type { Phase, PullRequest, ShippingStage } from "./events.ts";

export type FlowStep = "plan" | "implementing" | "review" | "ci" | "merged";
const PHASE_STEP: Partial<Record<Phase, FlowStep>> = {
  planning: "plan",
  "awaiting-approval": "plan",
  released: "plan",
  implementing: "implementing",
  "ready-to-merge": "ci",
  merged: "merged",
};

// Copied from packages/core/src/overview.ts (flowStep and pipeline), THE-1986.
// Waiting phases retain their last working step. No dependency on V1 or a clock.
export function flowStep(
  phase: Phase,
  stage: ShippingStage | undefined,
  pr: PullRequest | undefined,
  earlier: readonly Phase[],
): FlowStep {
  const shipping = stage ?? (pr && pr.ci !== "none" ? "ci" : "review");
  const of = (p: Phase) => (p === "shipping" ? shipping : PHASE_STEP[p]);
  const own = of(phase);
  if (own) return own;
  for (const p of [...earlier].reverse()) {
    const step = of(p);
    if (step && p !== "released") return step;
  }
  return pr ? shipping : "plan";
}

/** Zero-based index into plan, approval, implement, PR, CI, merge. */
export function pipelineStep(phase: Phase, pr: PullRequest | undefined): number {
  switch (phase) {
    case "planning":
    case "released":
      return 0;
    case "awaiting-approval":
      return 1;
    case "implementing":
      return 2;
    case "shipping":
      return pr && pr.ci !== "none" ? 4 : 3;
    case "blocked":
    case "awaiting-validation":
      return pr ? 3 : 1;
    case "ready-to-merge":
    case "merged":
      return 5;
  }
}
