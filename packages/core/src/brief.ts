// `armada brief`: the launch prompt a coordinator hands to a new worker, and
// the settings the runtime must receive. Armada never launches the worker; the
// runtime guide skill does, with what this returns. No secret value is ever
// part of a brief: environment variables are named, never read into it. The
// one exception is a one-time launch token (THE-841), made by Armada for a
// signed-in coordinator: the worker's first authenticated command exchanges it for a
// session limited to its ticket, so its runtime needs no key at all. It works
// once, within the hour, which makes a copy left in a transcript useless.
import type { ArmadaConfig, ConductorProfile, PlanPolicy, ProfileRuntime } from "./config.ts";
import { inFlight } from "./fleet.ts";
import { herdrChoice } from "./herdr-profile.ts";
import type { HttpRetryOptions } from "./http.ts";
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
import { extractInShort, lintTicket, lintWarning } from "./lint.ts";
import type { Reservation } from "./live.ts";
import { buildModel } from "./model.ts";
import { ARMADA_PACKAGE, type NpmCheck } from "./npm.ts";
import type { OverlapReading } from "./overlap.ts";
import { planRule } from "./phases.ts";
import {
  checkRequestedProfile,
  chooseProfile,
  type HerdrProfileChoice,
  hasProfileRules,
  type ProfileChoice,
  ProfileError,
  profileChoiceHint,
  routeProfile,
} from "./routing.ts";
import type { AgentPhase, ProgramData, StatusType } from "./types.ts";
import { chooseValidations, type ValidationChoice, ValidationChoiceError } from "./validations.ts";
import { Refusal } from "./worker.ts";

export { ARMADA_PACKAGE, checkPublished, NPM_CHECK_MS, NPM_REGISTRY_URL, type NpmCheck } from "./npm.ts";

/** Where `armada init` vendors the worker skill. */
export const WORKER_SKILL_PATH = ".agents/skills/armada-worker/SKILL.md";
/** Claim handle inside a Conductor workspace: both variables are set by Conductor. */
export const CONDUCTOR_HANDLE = '"$CONDUCTOR_WORKSPACE_ID/$CONDUCTOR_SESSION_ID"';
/**
 * Claim handle of a Claude Code subagent: the name the coordinator gives it at
 * launch, so SendMessage and TaskStop reach it by that name.
 */
export const subagentName = (ticket: string) => ticket.toLowerCase();
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
  files: string[];
  filesIncomplete: boolean;
  planPaths: string[];
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

/** A worker's one-time launch token, made by Armada when the coordinator is signed in. */
export interface BriefLaunch {
  token: string;
  expiresAt: string;
  /** The Armada the worker signs in to, when it is not the built-in address. */
  apiUrl: string | null;
}

export interface Brief {
  acceptance: ArmadaConfig["acceptance"];
  sharedResources: { declared: ArmadaConfig["reservations"]; holders: Reservation[]; warning: string | null };
  launchHint?: string;
  ticket: { id: string; title: string; url: string; branch: string | null; status: string; description: string };
  parent: { id: string; title: string; url: string } | null;
  /** Where the worker runs, from its profile: the `armada-runtime-<runtime>` skill launches it. */
  runtime: ProfileRuntime;
  profile: ({ name: string } & ConductorProfile) | null;
  /** How the profile was chosen: routing rule, legacy default, or the coordinator's choice and its reason. */
  routing: Omit<ProfileChoice, "name" | "profile"> | null;
  repository: { name: string; url: string };
  /**
   * The Armada version the worker installs: the coordinator's, or the newest
   * one npm serves when the coordinator's is not published yet.
   */
  armadaVersion: { pinned: string; coordinator: string };
  /** Installs the pinned Armada version as `armada` in the worker's workspace. */
  install: string;
  /** Runs that version where a global install is refused. */
  fallback: string;
  claimCommand: string;
  /** Actual local runtime handle, supplied after herdr creates the worktree. */
  handle?: string;
  /** `armada login --launch-token <token>`, the worker's first authenticated command, and when the token expires; null without one. */
  launch: { command: string; expiresAt: string } | null;
  /** Why there is no launch token, when there is none. */
  noLaunch: string | null;
  environment: BriefVariable[];
  blockers: BriefBlocker[];
  notes: BriefNote[];
  parallel: BriefWorker[];
  /** Whether the worker waits for approval of its plan, and why (`[policy] plans` or a ticket label). */
  plans: { rule: PlanPolicy; why: string };
  /** The `[[policy.validation]]` rules the coordinator judged apply (THE-885); null when the project has none. */
  validation: ValidationChoice | null;
  /** `[brief] extra`: the file every brief carries under "Project conventions"; null when unset or unreadable. */
  conventions: { path: string; text: string } | null;
  /** Context supplied by the coordinator for this launch; never changes plan policy. */
  coordinatorNotes: string | null;
  resume?: BriefResume | null;
  /** The first message of the worker's session. */
  prompt: string;
  warnings: string[];
}

export interface ProfileSelectionBrief {
  launchHint?: string;
  ticket: { id: string; title: string; url: string; inShort: string };
  parent: BriefTicket["parent"];
  selection: { profiles: { name: string; when: string | null }[]; hint: string };
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
  const data = await gql<{ issue: RawBriefIssue | null }>({ ...opts, retry: true }, BRIEF_QUERY, { id }).catch(
    (err: unknown) => {
      if (err instanceof LinearError && /not found/i.test(err.message)) return { issue: null };
      throw err;
    },
  );
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
];

export interface BriefResume {
  branch: string;
  head: string | null;
  pr: { number: number; url: string } | null;
  reason: string;
  previous: string;
  mode: "in-place" | "fresh";
  releasedReservations?: Pick<Reservation, "key" | "value">[];
}

export interface BuildBriefInput {
  overlap?: OverlapReading;
  config: ArmadaConfig;
  ticket: BriefTicket;
  /** The program as `armada status` reads it, for the workers in flight. */
  program: ProgramData;
  /** `--profile`, or null to follow the routing rules. */
  profile: string | null;
  /** Why the coordinator chose or overrode the profile; required for semantic choices and routing overrides. */
  reason?: string | null;
  /** Version of the coordinator's Armada CLI; the worker runs the same one. */
  version: string;
  /** What npm said of `version`; null when it was not asked. */
  npm?: NpmCheck | null;
  /** The coordinator's environment: only whether each variable is set is read. */
  env: Record<string, string | undefined>;
  /** Variables whose value comes from the machine credentials file. */
  stored?: string[];
  /** The launch token Armada made for this worker, if any. */
  launch?: BriefLaunch | null;
  /** Why there is none: the terminal is not signed in, or Armada refused. */
  noLaunch?: string | null;
  /** Why the coordinator added the pre-approved label for this launch. */
  preApprovedReason?: string | null;
  /** The `[brief] extra` file as read from the repository; `text` is null when it could not be read. */
  conventions?: { path: string; text: string | null } | null;
  /** The coordinator's judgement of `[[policy.validation]]` (`chooseValidations`). */
  validation?: ValidationChoice | null;
  notes?: string | null;
  resume?: BriefResume | null;
  now: Date;
  herdr?: { choice: HerdrProfileChoice; handle: string };
  reservations?: Reservation[];
  reservationsWarning?: string | null;
}

/** Thrown for a profile that does not exist or cannot be chosen (a usage mistake). */
export class BriefError extends Error {
  override name = "BriefError";
  constructor(
    message: string,
    /** The command to run instead, when there is one to copy. */
    readonly next: string | null = null,
  ) {
    super(message);
  }
}

export function buildBrief(input: BuildBriefInput): Brief {
  const { config, ticket, program } = input;
  // Both reads may warn about the same failed page; say it once.
  const warnings = [...new Set([...ticket.warnings, ...program.warnings])];
  warnings.push(
    ...lintTicket(
      { ...ticket, isSpec: ticket.parent?.id === config.tracker.programRoot && /^Spec\b/i.test(ticket.title) },
      config.tracker.lint,
    ).map((p) => lintWarning(ticket.id, p)),
  );
  if (!input.overlap || input.overlap.incomplete)
    warnings.push(
      "Comparison incomplete: in-flight PR files could not be read from Armada; sign in and refresh the project's stored reading.",
    );

  let choice: ProfileChoice | null;
  try {
    choice = input.herdr
      ? herdrChoice(input.herdr.choice)
      : chooseProfile(config, {
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
  if (self && !input.resume)
    warnings.push(`${ticket.id} is already in flight (${self.phase}); launching again makes a second worker`);
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
      files: input.overlap?.workers.find((w) => w.ticket === l.issue.id)?.files ?? [],
      filesIncomplete:
        input.overlap?.incomplete !== false ||
        input.overlap.workers.find((w) => w.ticket === l.issue.id)?.filesComplete !== true,
      planPaths: input.overlap?.workers.find((w) => w.ticket === l.issue.id)?.plan ?? [],
    }));

  for (const worker of input.overlap?.workers ?? []) {
    if (worker.ticket === ticket.id || parallel.some((w) => w.id === worker.ticket)) continue;
    const issue = program.issues.find((i) => i.id === worker.ticket);
    parallel.push({
      id: worker.ticket,
      title: issue?.title ?? "Live worker",
      url: issue?.url ?? "",
      phase: issue?.agentPhase ?? "planning",
      branch: null,
      pr: worker.pr === null ? null : `https://github.com/${config.github.repository}/pull/${worker.pr}`,
      files: worker.files ?? [],
      filesIncomplete: input.overlap?.incomplete !== false || !worker.filesComplete,
      planPaths: worker.plan,
    });
  }

  // Not `npx <package>`: inside the Armada repository itself, npx resolves the
  // workspace package of the same name, which has no built command.
  const pinned = npmPin(input.version, input.npm ?? null, warnings);
  const pkg = `${ARMADA_PACKAGE}@${pinned}`;
  const branch = input.resume?.branch ?? ticket.branchName;
  const runtime = choice?.profile.runtime ?? "conductor";
  const handle = input.herdr
    ? shellWord(input.herdr.handle)
    : runtime === "claude-code"
      ? subagentName(ticket.id)
      : CONDUCTOR_HANDLE;
  const claimCommand = [
    `armada claim ${ticket.id} --runtime ${runtime} --handle ${handle}`,
    branch ? ` --branch ${shellWord(branch)}` : "",
    choice ? ` --profile ${shellWord(choice.name)}` : "",
    choice?.reason ? ` --reason ${shellWord(choice.reason)}` : "",
    ...(input.validation?.rules.length
      ? [
          ` --validation ${input.validation.rules.map((r) => r.index).join(",")}`,
          input.validation.reason ? ` --validation-reason ${shellWord(input.validation.reason)}` : "",
        ]
      : []),
  ].join("");
  const has = (name: string) => !!input.env[name]?.trim();
  const launch = input.launch ?? null;
  const environment: BriefVariable[] = [
    ...VARIABLES.map((v) => ({
      ...v,
      // With a launch token the worker gets its keys from Armada.
      ...(launch ? { required: false, purpose: `${v.purpose}; not needed: the launch token signs the worker in` } : {}),
      value: null,
      inShell: has(v.name),
      inStore: !has(v.name) && !!input.stored?.includes(v.name),
    })),
    // A subagent inherits the coordinator's environment: nothing is set for it alone.
    ...(runtime === "claude-code"
      ? []
      : [
          {
            name: "ARMADA_TICKET",
            required: true,
            value: ticket.id,
            inShell: false,
            inStore: false,
            purpose: "the ticket this worker owns",
          },
        ]),
  ];

  const extra = input.conventions ?? null;
  if (extra && extra.text === null)
    warnings.push(`[brief] extra names ${extra.path}, which could not be read; the brief has no project conventions`);
  else if (extra && !extra.text?.trim()) warnings.push(`[brief] extra names ${extra.path}, which is empty`);

  const brief: Omit<Brief, "prompt"> = {
    sharedResources: {
      declared: config.reservations,
      holders: input.reservations ?? [],
      warning: input.reservationsWarning ?? null,
    },
    ticket: {
      id: ticket.id,
      title: ticket.title,
      url: ticket.url,
      branch,
      status: ticket.status,
      description: ticket.description,
    },
    parent: ticket.parent,
    runtime,
    profile: choice ? { name: choice.name, ...choice.profile } : null,
    routing: choice
      ? { source: choice.source, rule: choice.rule, routed: choice.routed, reason: choice.reason, why: choice.why }
      : null,
    repository: { name: config.github.repository, url: `https://github.com/${config.github.repository}` },
    armadaVersion: { pinned, coordinator: input.version },
    install: `npm install -g ${pkg}`,
    fallback: `npm exec --yes --package=${pkg} -- armada`,
    claimCommand,
    ...(input.herdr ? { handle: input.herdr.handle } : {}),
    launch: launch
      ? {
          command: `armada login --launch-token ${shellWord(launch.token)}${launch.apiUrl ? ` --api-url ${shellWord(launch.apiUrl)}` : ""}`,
          expiresAt: launch.expiresAt,
        }
      : null,
    noLaunch: launch ? null : (input.noLaunch ?? null),
    environment,
    blockers: ticket.blockers.map(({ notes, ...b }) => ({ ...b, handBack: handBackNote(notes) })),
    notes: ticket.notes.slice(0, MAX_NOTES),
    parallel,
    acceptance: config.acceptance,
    plans: (() => {
      const plans = planRule(config, ticket.labels);
      return plans.rule === "pre-approved" && input.preApprovedReason
        ? { ...plans, why: `${plans.why} (added at launch: ${input.preApprovedReason})` }
        : plans;
    })(),
    coordinatorNotes: input.notes?.trim() || null,
    resume: input.resume ?? null,
    validation: input.validation ?? null,
    conventions: extra?.text?.trim() ? { path: extra.path, text: extra.text } : null,
    warnings,
  };
  if (ticket.notes.length > MAX_NOTES)
    warnings.push(`${ticket.id} has ${ticket.notes.length} comments; the brief carries the newest ${MAX_NOTES}`);
  return { ...brief, prompt: renderPrompt(brief) };
}

/**
 * The version the brief pins: the coordinator's, unless npm does not serve it
 * yet (a release still publishing, a checkout ahead of npm) and an older one
 * is published. Each case npm leaves in doubt is a warning.
 */
function npmPin(version: string, npm: NpmCheck | null, warnings: string[]): string {
  if (!npm || npm.state === "published") return version;
  if (npm.state === "unknown") {
    warnings.push(
      `could not check that armada ${version} is on npm (${npm.reason}); if it is not published yet, the worker's install fails`,
    );
    return version;
  }
  if (!npm.newest) {
    warnings.push(
      `armada ${version} is not on npm, nor any older version: the worker's install and its fallback line fail until it is published`,
    );
    return version;
  }
  warnings.push(
    `armada ${version} is not on npm yet: this brief pins ${npm.newest}, the newest published version. The skills of this checkout may describe commands ${npm.newest} lacks; publish ${version} (the release pull request) and brief again to launch with it`,
  );
  return npm.newest;
}

/** A shell word: as is when it is plain, else single-quoted. */
export const shellWord = (s: string) => (/^\w[\w./:@+-]*$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

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
  const subagent = b.runtime === "claude-code";
  const out: string[] = [
    `# ${t.id} — ${t.title}`,
    "",
    `You are an Armada worker. You own exactly one ticket, ${t.id} (${t.url}), and turn it into one green pull request on ${b.repository.name}. After installing Armada, read your skill with \`armada skill armada-worker\` and follow its output and the repository's \`AGENTS.md\`. Never merge.`,
    "",
    ...(subagent
      ? [
          "## Before anything: your own worktree",
          "",
          `You run as a Claude Code subagent of the coordinator's session, in your own git worktree. Before you run anything else or touch a file, check that \`git rev-parse --show-toplevel\` is a folder under \`.claude/worktrees/\`. If it is not, you are in the coordinator's checkout: call the \`EnterWorktree\` tool with the name \`${subagentName(t.id)}\` and work only there. If it is refused, change nothing: reply that you were launched without a worktree and end your turn; the coordinator relaunches you in one. Never edit, commit or switch branches in the coordinator's checkout.`,
          "",
        ]
      : []),
    subagent ? "## Then: install Armada and claim the ticket" : "## First: install Armada and claim the ticket",
    "",
    ...(subagent
      ? [
          "Run install, read the worker skill, login and claim first. Immediately after claim, run the final heartbeat line as a separate Bash tool call with `run_in_background: true`; keep that Bash owned by this subagent.",
          "",
        ]
      : []),
    "```sh",
    b.install,
    "armada skill armada-worker",
    ...(b.launch ? [b.launch.command] : []),
    b.claimCommand,
    `armada heartbeat --every 5m --ticket ${t.id} --handle ${b.handle ? shellWord(b.handle) : subagent ? subagentName(t.id) : CONDUCTOR_HANDLE} --parent "$PPID"${subagent ? "" : " --background"}`,
    "```",
    "",
    subagent
      ? "Keep this Bash heartbeat in the subagent's background: it dies with the subagent, which is intended. Do not detach it from the subagent. If background processes are unavailable, report manually at least every 15 minutes."
      : "The heartbeat detaches from the short-lived command shell (a new process group, like nohup + setsid) and keeps a PID file under ~/.config/armada/watch/. Its monitored parent is the agent PID ($PPID in the command shell), never the shell PID ($$); it stops if that agent exits between turns. No heartbeat or manual report is required while awaiting-approval, blocked or awaiting-validation until someone answers. On resume, report the working phase and run the heartbeat line again with the current $PPID; an existing heartbeat for the same claim is kept. A newer answer or report starts a fresh silence window even when the old heartbeat is stale. If startup fails or the runtime cannot keep a background process, report manually at least every 15 minutes during active work instead.",
    "",
    `${b.armadaVersion.pinned === b.armadaVersion.coordinator ? "This installs the coordinator's Armada version." : `This installs Armada ${b.armadaVersion.pinned}, the newest on npm (the coordinator runs ${b.armadaVersion.coordinator}, not published yet).`} If the global install is refused, use \`${b.fallback}\` wherever this brief or the skill says \`armada\`.`,
    ...(b.launch
      ? [
          "",
          `\`armada login --launch-token\` signs this workspace in to Armada as the worker of ${t.id}, with a one-time token valid until ${b.launch.expiresAt.slice(0, 16).replace("T", " ")} UTC. Run it once before claim.`,
        ]
      : []),
    "",
    "If the claim is refused, stop and quote the refusal in your reply (usually another worker holds the ticket).",
    "After claiming, Armada checks repository read access, a dry-run push of your branch and commit signing; if it reports blocked, keep the claim, stop and quote the reason to the coordinator.",
    "",
    "## Branch",
    "",
    b.runtime === "herdr"
      ? `Herdr already created your own worktree on \`${t.branch}\`. Work only there. Before editing, check \`git branch --show-current\` and \`git rev-parse --show-toplevel\`; do not rename the branch or switch the coordinator's checkout. Your runtime handle is \`${b.handle}\`.`
      : t.branch
        ? b.resume?.mode === "in-place"
          ? `Continue on \`${t.branch}\` in this workspace. Check \`git status\` and \`git branch --show-current\` before editing; keep the ticket's branch.`
          : `Work on \`${t.branch}\`. Your ${subagent ? "worktree starts on a branch Claude Code" : "workspace starts on a branch Conductor"} named; rename it before your first commit: \`git branch -m ${shellWord(t.branch)}${b.resume?.head ? ` && git branch --set-upstream-to ${shellWord(`origin/${t.branch}`)}` : ""}\`.`
        : "Linear suggests no branch name for this ticket; name yours after the ticket id.",
    "",
    ...(b.runtime === "herdr"
      ? [
          `You share the coordinator's machine, but own only ${t.id}. Pass \`--ticket ${t.id}\` to every \`armada report\`, \`ask\`, \`release\` and \`validate\`; an inherited \`ARMADA_TICKET\` may name the coordinator's ticket. Herdr keeps your terminal alive when the coordinator disconnects.`,
          "",
        ]
      : []),
    ...(subagent
      ? [
          `You share the coordinator's machine and environment: its \`ARMADA_TICKET\`, if it has one, is not yours. Pass \`--ticket ${t.id}\` to every \`armada report\`, \`ask\` and \`release\`. You end when the coordinator's session ends: report at every step, so the ticket always says where you are.`,
          "",
        ]
      : []),
  ];
  if (b.runtime === "herdr" && b.profile)
    out.push(
      "## Harness",
      "",
      `Profile ${b.profile.name}: ${b.profile.agent}, model ${b.profile.model}, effort ${b.profile.effort}.`,
      "",
    );
  if (b.resume) {
    const r = b.resume;
    out.push(
      "## Continuing earlier work",
      "",
      `Relaunch reason: ${r.reason}. Previous worker: \`${r.previous}\`. Mode: ${r.mode}.`,
      "",
      `Continue the ticket's earlier work on branch \`${r.branch}\`. ${r.head ? `Pushed branch head: \`${r.head}\`.` : r.mode === "in-place" ? "The remote branch is absent; continue from the files in this workspace." : "The remote branch is absent; this fresh workspace starts from the base branch."}`,
      ...(r.pr
        ? [
            "",
            `Pull request #${r.pr.number} is open: ${r.pr.url}. Push to it, never open a second one, never force-push.`,
          ]
        : []),
      ...(r.mode === "in-place"
        ? [
            "",
            "The previous worker's files are in this workspace: check `git status` first. Preserve its uncommitted and unpushed work.",
          ]
        : []),
      ...(r.releasedReservations?.length
        ? [
            "",
            "Relaunch released the previous worker's shared reservations. After claiming, reacquire each previous value before using the existing work:",
            ...r.releasedReservations.map(
              (reservation) =>
                `- \`armada reserve ${shellWord(reservation.key)}${reservation.value ? ` --value ${shellWord(reservation.value)}` : ""}\``,
            ),
            "If a previous value is now held by another ticket, stop and ask the coordinator before changing or using it.",
          ]
        : []),
      "",
    );
  }
  if (t.description) out.push("## Ticket", "", quote(t.description), "");
  if (b.parent)
    out.push("## Parent", "", `${b.parent.id} — ${b.parent.title} (${b.parent.url}). Read it before planning.`, "");
  if (b.coordinatorNotes)
    out.push(
      "## Coordinator notes",
      "",
      "From the coordinator, for this launch. They add context; the Plan line below still decides whether your plan waits for approval.",
      "",
      b.coordinatorNotes,
      "",
    );
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
  out.push(
    "## Plan",
    "",
    b.plans.rule === "pre-approved"
      ? `Plans are pre-approved for ${t.id} (${b.plans.why}): post your plan with \`armada report implementing --plan-file -\` and go on.`
      : `Plans need the coordinator's approval for ${t.id} (${b.plans.why}): post your plan with \`armada report awaiting-approval --plan-file -\` and wait for approval.`,
    "",
  );
  if (b.acceptance.length) {
    out.push(
      "## Live acceptance",
      "",
      "Bring main in first only if your pull request conflicts (GitHub says DIRTY). Run applicable checks with `armada acceptance run` (or `--name <name>` for one check). Your checkout must be clean and HEAD must equal the PR head. Every error the check prints is part of this ticket: fix them all before handing back.",
      "",
    );
    for (const rule of b.acceptance)
      out.push(
        `- ${rule.name}: \`${rule.command}\`; ${rule.paths ? `paths: ${rule.paths.join(", ")}` : "every PR"}; timeout ${rule.timeoutMinutes} minutes; ${rule.maxRuns} runs per ticket.`,
        "",
      );
    out.push(
      "A changed head needs a new pass. Failed, timed-out and interrupted attempts count. At the cap, ask the coordinator for `armada acceptance allow <ticket> --runs <n> --reason <why>`. Commands needing secrets must use `armada run -- …`.",
      "",
    );
  }
  const validation = b.validation?.rules ?? [];
  if (validation.length)
    out.push(
      "## Owner validation",
      "",
      `This ticket needs the owner's validation: ${validation.map((r) => r.show.replace(/[.\s]+$/, "")).join("; ")}.`,
      "",
      `The coordinator judged it so${b.validation?.reason ? `: ${b.validation.reason}` : ""}. Submit your work with \`armada validate "<what to check>" --attach <files|urls>\`: your phase becomes \`awaiting-validation\`, the owner sees it on Armada's Validations page, and you stop until the coordinator relays their decision. On "Request changes", revise and submit again.`,
      "",
    );
  out.push("## Workers in flight", "");
  if (b.parallel.length) {
    out.push(
      "Declare overlaps in your plan and proceed additively; bring main in only if your pull request conflicts (GitHub says DIRTY). Ask the coordinator only when you must change a contract that another in-flight ticket relies on.",
      "",
    );
    for (const w of b.parallel) {
      out.push(
        `- ${w.id} — ${w.title} (${w.phase})${w.branch ? `, branch \`${w.branch}\`` : ""}${w.pr ? `, ${w.pr}` : ""}`,
      );
      if (w.files.length)
        out.push(
          `  PR files: ${w.files
            .slice(0, 15)
            .map((f) => `\`${f}\``)
            .join(", ")}${w.files.length > 15 ? `, +${w.files.length - 15} more` : ""}`,
        );
      if (w.planPaths.length) out.push(`  Plan paths: ${w.planPaths.map((f) => `\`${f}\``).join(", ")}`);
      if (!w.files.length && !w.planPaths.length && !w.filesIncomplete) out.push("  no files yet");
      if (w.filesIncomplete) out.push("  Comparison incomplete: PR files are unavailable or not all files were read.");
    }
  } else out.push("None.");
  out.push(
    "",
    "## Environment",
    "",
    b.launch
      ? `No key is needed in this workspace: once signed in, Armada hands each command the keys it needs, for ${t.id} only. If a command says this worker was cut off from Armada, stop and say so in your reply. Never print, commit or log a token or a key.`
      : subagent
        ? "You run with the coordinator's environment and keys. Never print, commit or log their values."
        : `The coordinator set ${b.environment.map((v) => `\`${v.name}\``).join(", ")} in this workspace. Never print, commit or log their values.`,
    "Never print environment variables, process lists with their arguments (ps -ef/aux, /proc/*/environ) or credential files: your tool output is your transcript.",
  );
  // The project's own text, as is: it speaks to every worker of the project.
  if (b.sharedResources.declared.length || b.sharedResources.holders.length || b.sharedResources.warning) {
    out.push(
      "",
      "## Shared resources",
      "",
      "Reserve shared numbers and names with `armada reserve`; never guess. `armada reserve --list` shows current holders.",
      "",
    );
    for (const r of b.sharedResources.declared)
      out.push(`- ${r.key}: ${r.what}${r.numbered ? " (numbered; use --next --floor <last used number>)" : ""}`);
    for (const r of b.sharedResources.holders)
      out.push(
        `- ${r.key}${r.value ? ` = ${r.value}` : " (exclusive)"}: ${r.ticket}${r.merged ? " (merged; used permanently)" : ""}${r.note ? ` — ${r.note}` : ""}`,
      );
    if (b.sharedResources.warning)
      out.push(
        `Current holders unavailable: ${b.sharedResources.warning}. Ask the coordinator before choosing a value.`,
      );
  }
  if (b.conventions) out.push("", "## Project conventions", "", b.conventions.text.trim());
  return `${out.join("\n")}\n`;
}

// ------------------------------------------------------------------ load

export interface LoadBriefOptions extends HttpRetryOptions {
  reservations?: () => Promise<Reservation[]>;
  overlap?: (input: { ticket: string; paths: string[] }) => Promise<OverlapReading>;
  prompt?: boolean;
  /** Checks/applies explicit plan pre-approval after policy judgments, before token minting. Previews return no reason. */
  preApprove?: (ticket: BriefTicket) => Promise<string | null>;
  linearApiKey: string;
  ticket: string;
  profile: string | null;
  reason?: string | null;
  version: string;
  env: Record<string, string | undefined>;
  stored?: string[];
  /**
   * Asks Armada for the worker's launch token, once the ticket is found open.
   * Else `reason` says why there is none, and is also a warning when `warn`;
   * the prompt then names the keys to pass.
   */
  launch?: (ticket: string) => Promise<BriefLaunch | { reason: string; warn: boolean }>;
  /** Asks npm whether `version` is published (`checkPublished`), beside the Linear reads; not asked when absent. */
  npm?: (version: string) => Promise<NpmCheck>;
  /** The `[brief] extra` file, read by the caller from the repository. */
  conventions?: { path: string; text: string | null } | null;
  /** `--validation` (none, or rule numbers) and `--validation-reason`; `command` is the coordinator's, for the refusal. */
  validation?: { requested: string | null; reason: string | null; command: string };
  fetch?: Fetch;
  now?: () => Date;
}

/** Reads the ticket and the program from Linear and builds the brief. */
export async function loadBrief(config: ArmadaConfig, opts: LoadBriefOptions): Promise<Brief | ProfileSelectionBrief> {
  const launchHint = "a one-time token is made when you print the prompt (--prompt)";
  const now = opts.now ?? (() => new Date());
  const linear = { apiKey: opts.linearApiKey, ...opts };
  // Fail on a bad profile before any network call.
  try {
    checkRequestedProfile(config, opts.profile);
  } catch (err) {
    if (err instanceof ProfileError) throw new BriefError(err.message);
    throw err;
  }
  const [ticket, program, npm] = await Promise.all([
    fetchBriefTicket(linear, opts.ticket),
    fetchProgram({ ...linear, rootId: config.tracker.programRoot, labels: config.tracker.labels, now }),
    opts.npm?.(opts.version) ?? null,
  ]);
  if (!ticket)
    throw new Refusal(`ticket ${opts.ticket} not found in Linear`, "armada status, to see the tickets of the program");
  if (opts.profile === null && hasProfileRules(config) && !routeProfile(config, ticket.labels))
    return {
      launchHint,
      ticket: {
        id: ticket.id,
        title: ticket.title,
        url: ticket.url,
        inShort: extractInShort(ticket.description, config.tracker.lint.inShort) ?? "",
      },
      parent: ticket.parent,
      selection: {
        profiles: Object.entries(config.conductor.profiles).map(([name, profile]) => ({
          name,
          when: profile.when ?? null,
        })),
        hint: profileChoiceHint(ticket.id),
      },
      warnings: [
        ...new Set([
          ...ticket.warnings,
          ...program.warnings,
          ...lintTicket(
            { ...ticket, isSpec: ticket.parent?.id === config.tracker.programRoot && /^Spec\b/i.test(ticket.title) },
            config.tracker.lint,
          ).map((p) => lintWarning(ticket.id, p)),
        ]),
      ],
    };
  try {
    chooseProfile(config, {
      ticket: ticket.id,
      labels: ticket.labels,
      requested: opts.profile,
      reason: opts.reason ?? null,
    });
  } catch (err) {
    if (err instanceof ProfileError) throw new BriefError(err.message);
    throw err;
  }
  // Judged before a launch token is made: a refused brief launches nobody.
  let validation: ValidationChoice | null;
  try {
    validation = chooseValidations(config.policy.validations ?? [], {
      ticket: ticket.id,
      requested: opts.validation?.requested ?? null,
      reason: opts.validation?.reason ?? null,
      command: opts.validation?.command ?? `armada brief ${ticket.id}`,
    });
  } catch (err) {
    if (err instanceof ValidationChoiceError) throw new BriefError(`${err.message}`, err.next);
    throw err;
  }
  const preApprovedReason = await opts.preApprove?.(ticket);
  let overlap: OverlapReading | undefined;
  try {
    overlap = await opts.overlap?.({ ticket: ticket.id, paths: [] });
  } catch {
    /* Live detail stays optional; Linear still supplies the brief. */
  }
  const launch = await launchForBrief(ticket, opts.prompt === true ? opts.launch : undefined);
  const made = launch && "token" in launch ? launch : null;
  const missed = launch && "reason" in launch ? launch : null;
  if (missed?.warn) ticket.warnings.push(`no launch token: ${missed.reason}`);
  const { reservations, reservationsWarning } = await reservationsForBrief(
    opts.reservations,
    config.reservations.length > 0,
  );
  const brief = buildBrief({
    reservations,
    reservationsWarning,
    config,
    ticket,
    program,
    overlap,
    profile: opts.profile,
    reason: opts.reason ?? null,
    version: opts.version,
    npm,
    env: opts.env,
    ...(opts.stored ? { stored: opts.stored } : {}),
    launch: made,
    noLaunch: missed?.reason ?? null,
    preApprovedReason,
    conventions: opts.conventions ?? null,
    validation,
    now: now(),
  });
  return opts.prompt ? brief : { ...brief, launchHint };
}

async function launchForBrief(ticket: BriefTicket, launch: LoadBriefOptions["launch"]) {
  return ticket.statusType !== "completed" && ticket.statusType !== "canceled" && launch ? launch(ticket.id) : null;
}

/** Every runtime's brief reads the holders opportunistically, with an explicit unavailable warning. */
export async function reservationsForBrief(
  read?: () => Promise<Reservation[]>,
  declared = false,
): Promise<{ reservations: Reservation[]; reservationsWarning: string | null }> {
  if (!read) return { reservations: [], reservationsWarning: declared ? "sign in with armada login" : null };
  try {
    return { reservations: await read(), reservationsWarning: null };
  } catch {
    return { reservations: [], reservationsWarning: "Armada could not read reservations" };
  }
}
