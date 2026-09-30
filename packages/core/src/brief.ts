// `armada brief`: the launch prompt a coordinator hands to a new worker, and
// the settings the runtime must receive. Armada never launches the worker; the
// runtime guide skill does, with what this returns. No secret value is ever
// part of a brief: environment variables are named, never read into it.
import type { ArmadaConfig, ConductorProfile } from "./config.ts";
import { inFlight } from "./fleet.ts";
import {
  type Connection,
  type Fetch,
  fetchProgram,
  gql,
  LinearError,
  type LinearRequestOptions,
  type MoreOf,
  parseStatusLine,
  readRest,
} from "./linear.ts";
import { buildModel } from "./model.ts";
import { checkRequestedProfile, chooseProfile, type ProfileChoice, ProfileError } from "./routing.ts";
import type { AgentPhase, ProgramData, StatusType } from "./types.ts";

/** The npm package the worker runs Armada from. */
export const ARMADA_PACKAGE = "@the-vibe-company/armada";
/** Where `armada init` vendors the worker skill. */
export const WORKER_SKILL_PATH = ".agents/skills/armada-worker/SKILL.md";
/** Claim handle inside a Conductor workspace: both variables are set by Conductor. */
export const CONDUCTOR_HANDLE = '"$CONDUCTOR_WORKSPACE_ID/$CONDUCTOR_SESSION_ID"';
/** Newest comments of the ticket put in the brief. */
const MAX_NOTES = 10;

export interface BriefNote {
  url: string;
  author: string | null;
  createdAt: string;
  body: string;
}

export interface BriefBlocker {
  id: string;
  title: string;
  url: string;
  status: string;
  statusType: StatusType;
  /** The blocker's latest `ready-to-merge` status comment, else its latest status comment. */
  handBack: BriefNote | null;
}

export interface BriefWorker {
  id: string;
  title: string;
  url: string;
  phase: AgentPhase;
  branch: string | null;
  pr: string | null;
}

export interface BriefVariable {
  name: string;
  required: boolean;
  /** The value to pass, only for a variable that is not a secret (the ticket id). */
  value: string | null;
  /** Whether the coordinator's shell has it, since the launch command expands it there. */
  inShell: boolean;
  /** Whether it is only in the machine credentials file, which the shell must load first. */
  inStore: boolean;
  purpose: string;
}

export interface Brief {
  ticket: { id: string; title: string; url: string; branch: string | null; status: string; description: string };
  parent: { id: string; title: string; url: string } | null;
  runtime: "conductor";
  profile: ({ name: string } & ConductorProfile) | null;
  /** How the profile was chosen: routing rule, default, or the coordinator's override and its reason. */
  routing: Omit<ProfileChoice, "name" | "profile"> | null;
  repository: { name: string; url: string };
  /** Installs the coordinator's exact Armada version as `armada` in the worker's workspace. */
  install: string;
  /** Runs that version where a global install is refused. */
  fallback: string;
  claimCommand: string;
  environment: BriefVariable[];
  blockers: BriefBlocker[];
  notes: BriefNote[];
  parallel: BriefWorker[];
  /** The first message of the worker's session. */
  prompt: string;
  warnings: string[];
}

// ------------------------------------------------------------------ Linear read

interface RawNote {
  id: string;
  createdAt: string;
  body: string;
  user: { name: string } | null;
}

type RawNotes = Connection<RawNote>;

interface RawBriefIssue {
  identifier: string;
  title: string;
  url: string;
  branchName: string | null;
  description: string | null;
  state: { name: string; type: string };
  labels: Connection<{ name: string }>;
  parent: { identifier: string; title: string; url: string } | null;
  comments: RawNotes;
  inverseRelations: Connection<{
    type: string;
    issue: {
      identifier: string;
      title: string;
      url: string;
      state: { name: string; type: string };
      comments: RawNotes;
    };
  }>;
}

const NOTE = "id createdAt body user { name }";
const NOTES = `pageInfo { hasNextPage endCursor } nodes { ${NOTE} }`;
const RELATION = `type issue { identifier title url state { name type } comments(first: 50) { ${NOTES} } }`;
const BRIEF_QUERY = /* GraphQL */ `
  query Brief($id: String!) {
    issue(id: $id) {
      identifier title url branchName description
      state { name type }
      labels(first: 50) { pageInfo { hasNextPage endCursor } nodes { name } }
      parent { identifier title url }
      comments(first: 50) { ${NOTES} }
      inverseRelations(first: 25) { pageInfo { hasNextPage endCursor } nodes { ${RELATION} } }
    }
  }`;
/** Labels, comments and relations longer than the first page are read to the end. */
const MORE_LABELS: MoreOf = { field: "labels", nodes: "name", operation: "MoreBriefLabels", what: "labels" };
const MORE_NOTES: MoreOf = { field: "comments", nodes: NOTE, operation: "MoreBriefComments", what: "comments" };
const MORE_RELATIONS: MoreOf = {
  field: "inverseRelations",
  nodes: RELATION,
  operation: "MoreBriefRelations",
  what: "relations",
  first: 25,
};

/** The ticket as a brief needs it: description, parent, comments, and its blockers with their comments. */
export interface BriefTicket {
  id: string;
  title: string;
  url: string;
  branchName: string | null;
  description: string;
  status: string;
  statusType: StatusType;
  /** Linear label names, which route the ticket to a profile. */
  labels: string[];
  parent: { id: string; title: string; url: string } | null;
  /** Newest first. */
  notes: BriefNote[];
  blockers: (Omit<BriefBlocker, "handBack"> & { notes: BriefNote[] })[];
  warnings: string[];
}

const noteUrl = (issueUrl: string, id: string) => `${issueUrl}#comment-${id.slice(0, 8)}`;
const toNotes = (issueUrl: string, raw: RawNotes): BriefNote[] =>
  raw.nodes
    .map((c) => ({ url: noteUrl(issueUrl, c.id), author: c.user?.name ?? null, createdAt: c.createdAt, body: c.body }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** `warnings` are the reads that failed part way, from `fetchBriefTicket`. */
export function normalizeBriefTicket(raw: RawBriefIssue, warnings: string[] = []): BriefTicket {
  const blockers = raw.inverseRelations.nodes
    .filter((r) => r.type === "blocks")
    .map(({ issue: b }) => ({
      id: b.identifier,
      title: b.title,
      url: b.url,
      status: b.state.name,
      statusType: b.state.type as StatusType,
      notes: toNotes(b.url, b.comments),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  return {
    id: raw.identifier,
    title: raw.title,
    url: raw.url,
    branchName: raw.branchName || null,
    description: raw.description?.trim() ?? "",
    status: raw.state.name,
    statusType: raw.state.type as StatusType,
    labels: raw.labels.nodes.map((l) => l.name),
    parent: raw.parent ? { id: raw.parent.identifier, title: raw.parent.title, url: raw.parent.url } : null,
    notes: toNotes(raw.url, raw.comments),
    blockers,
    warnings,
  };
}

export async function fetchBriefTicket(opts: LinearRequestOptions, id: string): Promise<BriefTicket | null> {
  const data = await gql<{ issue: RawBriefIssue | null }>(opts, BRIEF_QUERY, { id }).catch((err: unknown) => {
    if (err instanceof LinearError && /not found/i.test(err.message)) return { issue: null };
    throw err;
  });
  const raw = data.issue;
  if (!raw) return null;
  const warnings: string[] = [];
  await readRest(opts, raw.identifier, MORE_LABELS, raw.labels, warnings);
  await readRest(opts, raw.identifier, MORE_NOTES, raw.comments, warnings);
  await readRest(opts, raw.identifier, MORE_RELATIONS, raw.inverseRelations, warnings);
  for (const r of raw.inverseRelations.nodes)
    if (r.type === "blocks") await readRest(opts, r.issue.identifier, MORE_NOTES, r.issue.comments, warnings);
  return normalizeBriefTicket(raw, warnings);
}

// ------------------------------------------------------------------ build

/** The hand-back of a blocker: its newest `ready-to-merge` status comment, else its newest status comment. */
export function handBackNote(notes: BriefNote[]): BriefNote | null {
  const withStatus = notes.filter((n) => parseStatusLine(n.body));
  return withStatus.find((n) => parseStatusLine(n.body)?.phase === "ready-to-merge") ?? withStatus[0] ?? null;
}

const VARIABLES: { name: string; required: boolean; purpose: string }[] = [
  { name: "LINEAR_API_KEY", required: true, purpose: "Linear key the worker claims and reports with" },
  { name: "ARMADA_TURSO_URL", required: false, purpose: "Turso database for live activity" },
  { name: "ARMADA_TURSO_TOKEN", required: false, purpose: "Turso database token" },
];

export interface BuildBriefInput {
  config: ArmadaConfig;
  ticket: BriefTicket;
  /** The program as `armada status` reads it, for the workers in flight. */
  program: ProgramData;
  /** `--profile`, or null to follow the routing rules. */
  profile: string | null;
  /** Why `--profile` overrides the routed profile; required then. */
  reason?: string | null;
  /** Version of the coordinator's Armada CLI; the worker runs the same one. */
  version: string;
  /** The coordinator's environment: only whether each variable is set is read. */
  env: Record<string, string | undefined>;
  /** Variables whose value comes from the machine credentials file. */
  stored?: string[];
  now: Date;
}

/** Thrown for a profile that does not exist or cannot be chosen (a usage mistake). */
export class BriefError extends Error {
  override name = "BriefError";
}

export function buildBrief(input: BuildBriefInput): Brief {
  const { config, ticket, program } = input;
  // Both reads may warn about the same failed page; say it once.
  const warnings = [...new Set([...ticket.warnings, ...program.warnings])];

  let choice: ProfileChoice | null;
  try {
    choice = chooseProfile(config, {
      ticket: ticket.id,
      labels: ticket.labels,
      requested: input.profile,
      reason: input.reason ?? null,
    });
  } catch (err) {
    if (err instanceof ProfileError) throw new BriefError(err.message);
    throw err;
  }
  if (!choice)
    warnings.push(
      "armada.toml declares no [conductor.profiles.<name>]; add one so the launch passes an explicit agent, model and effort",
    );

  if (ticket.statusType === "completed" || ticket.statusType === "canceled")
    warnings.push(`${ticket.id} is ${ticket.status}; there is nothing to launch`);
  const open = ticket.blockers.filter((b) => b.statusType !== "completed" && b.statusType !== "canceled");
  if (open.length) warnings.push(`${ticket.id} is blocked by ${open.map((b) => `${b.id} (${b.status})`).join(", ")}`);

  const m = buildModel(program.issues, program.rootId);
  const lanes = inFlight(m, program.comments, {
    now: input.now.getTime(),
    silentAfterMinutes: config.policy.silentAfterMinutes,
  });
  const self = lanes.find((l) => l.issue.id === ticket.id);
  if (self) warnings.push(`${ticket.id} is already in flight (${self.phase}); launching again makes a second worker`);
  if (!program.issues.some((i) => i.id === ticket.id))
    warnings.push(`${ticket.id} is not under the program root ${config.tracker.programRoot}`);
  const parallel: BriefWorker[] = lanes
    .filter((l) => l.issue.id !== ticket.id)
    .map((l) => ({
      id: l.issue.id,
      title: l.issue.title,
      url: l.issue.url,
      phase: l.phase,
      branch: l.claim?.branch ?? null,
      pr: l.pr?.url ?? null,
    }));

  // Not `npx <package>`: inside the Armada repository itself, npx resolves the
  // workspace package of the same name, which has no built command.
  const pkg = `${ARMADA_PACKAGE}@${input.version}`;
  const branch = ticket.branchName;
  const claimCommand = [
    `armada claim ${ticket.id} --runtime conductor --handle ${CONDUCTOR_HANDLE}`,
    branch ? ` --branch ${branch}` : "",
    choice ? ` --profile ${shellWord(choice.name)}` : "",
    choice?.reason ? ` --reason ${shellWord(choice.reason)}` : "",
  ].join("");
  const has = (name: string) => !!input.env[name]?.trim();
  const environment: BriefVariable[] = [
    ...VARIABLES.map((v) => ({
      ...v,
      value: null,
      inShell: has(v.name),
      inStore: !has(v.name) && !!input.stored?.includes(v.name),
    })),
    {
      name: "ARMADA_TICKET",
      required: true,
      value: ticket.id,
      inShell: false,
      inStore: false,
      purpose: "the ticket this worker owns",
    },
  ];

  const brief: Omit<Brief, "prompt"> = {
    ticket: {
      id: ticket.id,
      title: ticket.title,
      url: ticket.url,
      branch,
      status: ticket.status,
      description: ticket.description,
    },
    parent: ticket.parent,
    runtime: "conductor",
    profile: choice ? { name: choice.name, ...choice.profile } : null,
    routing: choice
      ? { source: choice.source, rule: choice.rule, routed: choice.routed, reason: choice.reason, why: choice.why }
      : null,
    repository: { name: config.github.repository, url: `https://github.com/${config.github.repository}` },
    install: `npm install -g ${pkg}`,
    fallback: `npm exec --yes --package=${pkg} -- armada`,
    claimCommand,
    environment,
    blockers: ticket.blockers.map(({ notes, ...b }) => ({ ...b, handBack: handBackNote(notes) })),
    notes: ticket.notes.slice(0, MAX_NOTES),
    parallel,
    warnings,
  };
  if (ticket.notes.length > MAX_NOTES)
    warnings.push(`${ticket.id} has ${ticket.notes.length} comments; the brief carries the newest ${MAX_NOTES}`);
  return { ...brief, prompt: renderPrompt(brief) };
}

/** A shell word: as is when it is plain, else single-quoted. */
export const shellWord = (s: string) => (/^[\w./:@=+-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** Quotes a comment body as a Markdown block quote, so its headings stay inside it. */
const quote = (body: string) =>
  body
    .trim()
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");

const byLine = (n: BriefNote) => `${n.author ?? "unknown"}, ${n.createdAt.slice(0, 16).replace("T", " ")}Z — ${n.url}`;

function renderPrompt(b: Omit<Brief, "prompt">): string {
  const t = b.ticket;
  const out: string[] = [
    `# ${t.id} — ${t.title}`,
    "",
    `You are an Armada worker. You own exactly one ticket, ${t.id} (${t.url}), and turn it into one green pull request on ${b.repository.name}. Follow the \`armada-worker\` skill (\`${WORKER_SKILL_PATH}\`) and the repository's \`AGENTS.md\`. Never merge.`,
    "",
    "## First: install Armada and claim the ticket",
    "",
    "```sh",
    b.install,
    b.claimCommand,
    "```",
    "",
    `This installs the coordinator's Armada version. If the global install is refused, use \`${b.fallback}\` wherever this brief or the skill says \`armada\`.`,
    "",
    "If the claim is refused, stop and say why in your reply: another worker holds the ticket.",
    "",
    "## Branch",
    "",
    t.branch
      ? `Work on \`${t.branch}\`. Your workspace starts on a branch Conductor named; rename it before your first commit: \`git branch -m ${t.branch}\`.`
      : "Linear suggests no branch name for this ticket; name yours after the ticket id.",
    "",
  ];
  if (t.description) out.push("## Ticket", "", quote(t.description), "");
  if (b.parent)
    out.push("## Parent", "", `${b.parent.id} — ${b.parent.title} (${b.parent.url}). Read it before planning.`, "");
  if (b.blockers.length) {
    out.push("## Blockers and their hand-back notes", "");
    for (const x of b.blockers) {
      out.push(`### ${x.id} — ${x.title} (${x.status})`, "", x.url, "");
      out.push(x.handBack ? `${byLine(x.handBack)}\n\n${quote(x.handBack.body)}` : "No hand-back note.", "");
    }
  }
  if (b.notes.length) {
    out.push(
      "## Already recorded on this ticket",
      "",
      "Newest first. Decisions here stand unless the coordinator changes them.",
      "",
    );
    for (const n of b.notes) out.push(`### ${byLine(n)}`, "", quote(n.body), "");
  }
  out.push("## Workers in flight", "");
  if (b.parallel.length) {
    out.push("Stay out of their areas. If you must change the same files, say so in a report before you do.", "");
    for (const w of b.parallel)
      out.push(
        `- ${w.id} — ${w.title} (${w.phase})${w.branch ? `, branch \`${w.branch}\`` : ""}${w.pr ? `, ${w.pr}` : ""}`,
      );
  } else out.push("None.");
  out.push(
    "",
    "## Environment",
    "",
    `The coordinator set ${b.environment.map((v) => `\`${v.name}\``).join(", ")} in this workspace. Never print, commit or log their values.`,
  );
  return `${out.join("\n")}\n`;
}

// ------------------------------------------------------------------ load

export interface LoadBriefOptions {
  linearApiKey: string;
  ticket: string;
  profile: string | null;
  reason?: string | null;
  version: string;
  env: Record<string, string | undefined>;
  stored?: string[];
  fetch?: Fetch;
  now?: () => Date;
}

/** Reads the ticket and the program from Linear and builds the brief. */
export async function loadBrief(config: ArmadaConfig, opts: LoadBriefOptions): Promise<Brief> {
  const now = opts.now ?? (() => new Date());
  const linear = { apiKey: opts.linearApiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) };
  // Fail on a bad profile before any network call.
  try {
    checkRequestedProfile(config, opts.profile);
  } catch (err) {
    if (err instanceof ProfileError) throw new BriefError(err.message);
    throw err;
  }
  const [ticket, program] = await Promise.all([
    fetchBriefTicket(linear, opts.ticket),
    fetchProgram({ ...linear, rootId: config.tracker.programRoot, labels: config.tracker.labels, now }),
  ]);
  if (!ticket) throw new Error(`ticket ${opts.ticket} not found in Linear`);
  return buildBrief({
    config,
    ticket,
    program,
    profile: opts.profile,
    reason: opts.reason ?? null,
    version: opts.version,
    env: opts.env,
    ...(opts.stored ? { stored: opts.stored } : {}),
    now: now(),
  });
}
