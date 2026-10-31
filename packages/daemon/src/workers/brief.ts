import type { ProjectTables, Ticket } from "@armada/protocol";
import { BUNDLED_SKILLS } from "../../../core/src/skills.ts";
import { labelKey } from "./routing.ts";

const shell = (value: string) => (/^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);
const LIMIT = 48 * 1024 - 1;
const MARKER = "\n[truncated: section shortened to fit the launch brief]";
const protocol = BUNDLED_SKILLS.find((skill) => skill.name === "armada-worker")?.files.find(
  (file) => file.path === "SKILL.md",
)?.content;
if (!protocol) throw new Error("Bundled armada-worker protocol is missing");

/** Cut at a UTF-8 boundary, counting the visible marker inside the byte budget. */
function cut(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const encoded = Buffer.from(text.endsWith(MARKER) ? text.slice(0, -MARKER.length) : text);
  let end = Math.max(0, bytes - Buffer.byteLength(MARKER));
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8") + MARKER;
}
export class BriefRefusal extends Error {}

export interface BriefFile {
  name: string;
  text: string;
}

/** Adapted from V1 core/brief.ts renderPrompt and phases.ts planRule.
 * The worker protocol is bundled text; npm is only a fallback for the CLI binary. */
export function workerBrief(input: {
  ticket: Ticket;
  tables: ProjectTables;
  repository: string;
  branch: string;
  instructions?: BriefFile;
  extra?: BriefFile;
  notes?: string;
  profileInstructions?: string;
  resume?: string;
  hosted?: { token: string; apiUrl: string; profile: string; project: string };
}) {
  const { ticket: t, tables } = input;
  const parent = tables.tickets.find((p) => p.id === t.parent);
  const has = (label: string) => t.labels?.some((l) => labelKey(l) === labelKey(label));
  const policy = tables.rules?.value.policy;
  const preApproved =
    !has(policy?.approvalLabel ?? "needs-plan-approval") &&
    (has(policy?.preApprovedLabel ?? "plan-approved") || policy?.plans === "pre-approved");
  const sections: { heading: string; body: string; optional: boolean }[] = [];
  const add = (heading: string, body: string, optional = false, cap = LIMIT) => {
    sections.push({ heading, body: optional ? cut(body, cap) : body, optional });
  };
  if (input.hosted)
    add("", `armada login --launch-token ${shell(input.hosted.token)} --api-url ${shell(input.hosted.apiUrl)}`);
  add(
    "",
    [
      `# ${t.id} — ${t.title}`,
      `You are an Armada worker. You own exactly one ticket, ${t.id}${t.url ? ` (${t.url})` : ""}, and turn it into one green pull request on ${input.repository}. Never merge. Follow the repository's instructions.`,
    ].join("\n\n"),
  );
  add("## Ticket", t.description || t.title);
  if (parent)
    add(
      `## Parent\n\n${parent.id} — ${parent.title}`,
      parent.description || "Read the parent spec before planning.",
      true,
      4096,
    );
  else if (t.parent) add("## Parent", `Read parent ${t.parent} before planning.`);
  if (input.instructions)
    add(`## Repository instructions (${input.instructions.name})`, input.instructions.text, true, 8192);
  if (input.extra) add(`## Project conventions (${input.extra.name})`, input.extra.text, true);
  if (input.notes) add("## Coordinator notes", input.notes, true);
  add("## Worker protocol", protocol!);
  if (input.profileInstructions) add("## Profile instructions", input.profileInstructions, true);
  add(
    "## Launch instructions",
    [
      "Read all context in this brief before claiming. The launch instructions and Plan line here take precedence over the bundled protocol's hosted login, runtime flags and plan examples.",
      "The worker protocol above is complete and available offline. Use the installed Armada CLI when present. Only if the CLI binary is missing, try:",
      // First released CLI supporting the local socket protocol.
      "```sh\nif ! command -v armada >/dev/null 2>&1; then\n  npm install -g @the-vibe-company/armada@0.2.67\nfi\n```",
      "If CLI installation fails, say so in your first report. Then try `npm exec --yes --package=@the-vibe-company/armada@0.2.67 -- armada` for the CLI binary; if it fails, say so in your first report. The protocol does not depend on npm. If no CLI can run, state the failure in your first reply so the coordinator can recover the launch.",
      ...(input.hosted
        ? [
            "Run the login line at the top once, after installing the CLI and before claim.",
            `The launch is scoped to Armada project \`${input.hosted.project}\`. Select the repository's Armada config whose project.slug matches; set ARMADA_CONFIG for every command when that file is not armada.toml. Conductor has already selected profile \`${input.hosted.profile}\`; its profile name need not be a V1 CLI profile.`,
            `Run \`armada claim ${t.id} --runtime conductor --handle "\${CONDUCTOR_WORKSPACE_ID}/\${CONDUCTOR_SESSION_ID}" --branch ${shell(input.branch)}\`. If authorization is refused, stop and quote the refusal.`,
            `Rename the current branch with \`git branch -m ${shell(input.branch)}\` before your first commit, then work only on it. The workspace starts on the repository default branch.`,
          ]
        : [
            `Run \`armada claim ${t.id}\`. Your per-ticket capability is already in the environment; never print it, read credential files or sign in to hosted Armada. If authorization is refused, stop and quote the refusal.`,
            `Work only in this prepared worktree on branch \`${input.branch}\`. Check git status and the current branch before editing; keep the branch.`,
          ]),
    ].join("\n\n"),
  );
  if (input.resume)
    add(
      "## Continuing earlier work",
      `${input.resume}\nPreserve uncommitted and unpushed files. Continue the existing pull request; never open a second one or force-push.`,
    );
  for (const blocker of t.blockers ?? [])
    add(
      `## Blocker ${blocker.id} (${blocker.status})`,
      tables.tickets
        .find((x) => x.id === blocker.id)
        ?.comments?.map((c) => c.body)
        .join("\n\n") || "Read its hand-back before planning.",
      true,
    );
  for (const comment of (t.comments ?? []).slice(0, 12))
    add(`## Recorded by ${comment.author} at ${comment.at}`, comment.body, true);
  add(
    "## Plan",
    preApproved
      ? `Plans are pre-approved for ${t.id}: post your plan with \`armada report implementing --message "<plan>"\` and go on.`
      : `Plans need the coordinator's approval: post your plan with \`armada report awaiting-approval --message "<plan>"\` and wait for its answer.`,
  );
  add(
    "## Reports and hand-back",
    [
      `Report each meaningful step with \`armada report <phase> --message "<progress>"\`; during active work run \`armada heartbeat --every 5m --ticket ${t.id} --parent "$PPID" --background\`. Use \`armada ask "<question>"\` for outcome-changing decisions and wait for the answer. Waiting for approval or an answer is legitimate.`,
      'Run the repository\'s required checks and independent review, push the branch and get every PR check green. Hand back with `armada report ready-to-merge --pr <number> --sha <full 40-character head> --message "<verification and decisions>"`. Never merge. Use `armada release --reason "<why>"` if you cannot finish.',
    ].join("\n\n"),
  );
  const flight = tables.sessions.filter((s) => s.ticket !== t.id && s.phase !== "released" && s.phase !== "merged");
  if (flight.length)
    add(
      "## Workers in flight",
      flight.map((s) => `- ${s.ticket}: ${s.reason}. Declare overlaps in your plan and proceed additively.`).join("\n"),
      true,
    );
  add(
    "",
    "Never print tokens, environment variables, credential files or process arguments. Secrets belong only in the launch environment, never in reports or git.",
  );
  const render = () => sections.map((s) => [s.heading, s.body].filter(Boolean).join("\n\n")).join("\n\n");
  let brief = render();
  while (Buffer.byteLength(brief) > LIMIT) {
    const longest = sections
      .filter((s) => s.optional && Buffer.byteLength(s.body) > Buffer.byteLength(MARKER))
      .sort((a, b) => Buffer.byteLength(b.body) - Buffer.byteLength(a.body))[0];
    if (!longest)
      throw new BriefRefusal(
        "The ticket and worker protocol cannot fit under 48 KiB; shorten the ticket before launching",
      );
    const length = Buffer.byteLength(longest.body);
    longest.body = cut(
      longest.body,
      Math.max(Buffer.byteLength(MARKER), length - Math.max(Buffer.byteLength(brief) - LIMIT, Math.floor(length / 2))),
    );
    brief = render();
  }
  return brief;
}
