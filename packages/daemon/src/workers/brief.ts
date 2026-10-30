import type { ProjectTables, Ticket } from "@armada/protocol";
import { labelKey } from "./routing.ts";

/** Adapted from V1 packages/core/src/brief.ts renderPrompt and phases.ts planRule.
 * The daemon capability replaces hosted login; no credentials enter the prompt. */
export function workerBrief(input: {
  ticket: Ticket;
  tables: ProjectTables;
  repository: string;
  branch: string;
  notes?: string;
  resume?: string;
}) {
  const { ticket: t, tables } = input;
  const parent = tables.tickets.find((p) => p.id === t.parent);
  const has = (label: string) => t.labels?.some((l) => labelKey(l) === labelKey(label));
  const policy = tables.rules?.value.policy;
  const preApproved =
    !has(policy?.approvalLabel ?? "needs-plan-approval") &&
    (has(policy?.preApprovedLabel ?? "plan-approved") || policy?.plans === "pre-approved");
  return [
    `# ${t.id} — ${t.title}`,
    `You are an Armada worker. You own exactly one ticket, ${t.id}${t.url ? ` (${t.url})` : ""}, and turn it into one green pull request on ${input.repository}. Never merge. Follow the repository's AGENTS.md.`,
    "## First: install Armada, read the worker skill and claim",
    // Pin the first released CLI supporting this local socket protocol, rather than a future hosted release.
    "```sh\nnpm install -g @the-vibe-company/armada@0.2.67\narmada skill armada-worker\n```",
    "If the global install is refused, prefix every Armada command with `npm exec --yes --package=@the-vibe-company/armada@0.2.67 -- armada`. Follow the worker skill’s delivery rules; the local socket instructions here replace its hosted login and runtime claim flags.",
    `Run \`armada claim ${t.id}\`. Your per-ticket capability is already in the environment; never print it, read credential files or sign in to hosted Armada. If authorization is refused, stop and quote the refusal.`,
    `Work only in this prepared worktree on branch \`${input.branch}\`. Check git status and the current branch before editing; keep the branch.`,
    input.resume
      ? `## Continuing earlier work\n\n${input.resume}\nPreserve uncommitted and unpushed files. Continue the existing pull request; never open a second one or force-push.`
      : "",
    `## Ticket\n\n${t.description || t.title}`,
    parent
      ? `## Parent\n\n${parent.id} — ${parent.title}\n\n${parent.description || "Read the parent spec before planning."}`
      : t.parent
        ? `Read parent ${t.parent} before planning.`
        : "",
    ...(t.blockers ?? []).map(
      (b) =>
        `## Blocker ${b.id} (${b.status})\n\n${
          tables.tickets
            .find((x) => x.id === b.id)
            ?.comments?.map((c) => c.body)
            .join("\n\n") || "Read its hand-back before planning."
        }`,
    ),
    ...(t.comments ?? []).slice(0, 12).map((c) => `## Recorded by ${c.author} at ${c.at}\n\n${c.body}`),
    "## Plan",
    preApproved
      ? `Plans are pre-approved for ${t.id}: post your plan with \`armada report implementing --message "<plan>"\` and go on.`
      : `Plans need the coordinator's approval: post your plan with \`armada report awaiting-approval --message "<plan>"\` and wait for its answer.`,
    "## Reports and hand-back",
    `Report each meaningful step with \`armada report <phase> --message "<progress>"\`; during active work run \`armada heartbeat --every 5m --ticket ${t.id} --parent "$PPID" --background\`. Use \`armada ask "<question>"\` for outcome-changing decisions and wait for the answer. Waiting for approval or an answer is legitimate.`,
    'Run the repository\'s required checks and independent review, push the branch and get every PR check green. Hand back with `armada report ready-to-merge --pr <number> --sha <full 40-character head> --message "<verification and decisions>"`. Never merge. Use `armada release --reason "<why>"` if you cannot finish.',
    "## Workers in flight",
    ...tables.sessions
      .filter((s) => s.ticket !== t.id && s.phase !== "released" && s.phase !== "merged")
      .map((s) => `- ${s.ticket}: ${s.reason}. Declare overlaps in your plan and proceed additively.`),
    "Never print tokens, environment variables, credential files or process arguments. Secrets belong only in the launch environment, never in reports or git.",
    ...(input.notes ? ["## Coordinator notes", input.notes] : []),
  ]
    .filter(Boolean)
    .join("\n\n");
}
