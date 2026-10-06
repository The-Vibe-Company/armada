// `armada claim | report | release`: how a worker tells the fleet where it is.
// Linear is written through the one write adapter; the fleet's live data is
// reached through Armada with this terminal's sign-in, and a failure there
// only warns. A release, and the coordinator's merge, end the ticket's worker
// sessions on Armada.
import {
  type ArmadaConfig,
  type Credentials,
  checkRequestedProfile,
  chooseValidations,
  claimTicket,
  createLinearWriter,
  type Fleet,
  fetchMergePull,
  fetchPullRequest,
  fleetClient,
  isLabelPhase,
  LABEL_PHASES,
  LINEAR_KEY,
  machinePaths,
  type Outcome,
  type PendingLaunch,
  ProfileError,
  projectOf,
  releaseTicket,
  reportPhase,
  ticketFromBranch,
  updateCredentialStore,
  type ValidationChoice,
  ValidationChoiceError,
  type WorkerContext,
  workerSessionVariable,
} from "@armada/core";
import { apiOf } from "./api.ts";
import { reportHerdr } from "./herdr.ts";
import { httpOptions, type Io, missingKey, UsageError } from "./io.ts";
import { sessionHandle } from "./login.ts";
import { observeRuntimes } from "./runtime.ts";

/**
 * The project's live data through Armada, signed in as this terminal: a
 * coordinator's session or API key, or the worker session of the ticket the
 * command acts on. Signed out, `fleet` is null and `warning` says so.
 */
export function liveFleet(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
): { fleet: Fleet | null; warning: string | null } {
  const signIn = credentials.armadaSignIn;
  if (!signIn)
    return {
      fleet: null,
      warning: "not signed in to Armada (armada login); live activity is not recorded, Linear is",
    };
  try {
    const api = apiOf(io, credentials.armadaApi.url);
    return { fleet: fleetClient({ api, signIn, project: projectOf(config) }), warning: null };
  } catch (err) {
    return {
      fleet: null,
      warning: `${err instanceof Error ? err.message : String(err)}; live activity is not recorded`,
    };
  }
}

/** What `armada status` reads through Armada: newest live event per ticket and launches not claimed; none when not signed in. */
export function statusLive(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
):
  | {
      lastEvents: () => Promise<Record<string, string>>;
      latestEvents: () => Promise<Record<string, import("@armada/core").LatestEvent>>;
      heartbeats: () => Promise<Record<string, string>>;
      launches: () => Promise<PendingLaunch[]>;
      deferredLaunches: () => Promise<import("@armada/core").DeferredLaunch[]>;
      runtimeHandles: () => Promise<import("@armada/core").RuntimeHandle[]>;
      holds: () => Promise<import("@armada/core").MergeHold[]>;
    }
  | undefined {
  const { fleet } = liveFleet(io, config, credentials);
  return fleet
    ? {
        lastEvents: () => fleet.lastEventTimes(),
        latestEvents: () => fleet.latestEvents(),
        heartbeats: () => fleet.heartbeatTimes(),
        launches: () => fleet.pendingLaunches(),
        deferredLaunches: () => fleet.deferredLaunches(),
        holds: () => fleet.holds(),
        runtimeHandles: () => observeRuntimes(io, fleet, config),
      }
    : undefined;
}

/**
 * --ticket, then ARMADA_TICKET, then the current git branch, then the one
 * ticket this machine holds a worker session for.
 */
export function currentTicket(
  io: Io,
  config: ArmadaConfig,
  explicit: string | undefined,
  workers: string[] = [],
): string {
  const fromEnv = io.env.ARMADA_TICKET?.trim();
  const id =
    explicit?.trim() ||
    fromEnv ||
    (() => {
      const branch = io.gitBranch?.();
      return branch ? ticketFromBranch(branch, config.tracker.programRoot) : null;
    })() ||
    (workers.length === 1 ? workers[0] : null);
  if (!id) throw new UsageError("which ticket? pass --ticket <id>, set ARMADA_TICKET, or run on the ticket's branch");
  return id.toUpperCase();
}

export function workerContext(io: Io, config: ArmadaConfig, credentials: Credentials): WorkerContext {
  if (!credentials.linearApiKey) throw missingKey(LINEAR_KEY);
  const linearOpts = {
    apiKey: credentials.linearApiKey,
    labels: config.tracker.labels,
    ...httpOptions(io),
  };
  const linear = io.linearWriter ? io.linearWriter(linearOpts) : createLinearWriter(linearOpts);
  const live = liveFleet(io, config, credentials);
  const token = credentials.githubToken;
  return {
    config,
    linear,
    workerSession: credentials.armadaSignIn?.kind === "worker",
    workerHandle: !credentials.armadaSignIn || credentials.armadaSignIn.kind === "worker" ? sessionHandle(io) : null,
    workerPane:
      io.env.HERDR_ENV === "1" &&
      (!credentials.armadaSignIn || credentials.armadaSignIn.kind === "worker" || io.env.ARMADA_TICKET)
        ? io.env.HERDR_PANE_ID?.trim()
        : null,
    fleet: async () => live,
    readPull: token
      ? (number) =>
          fetchPullRequest({
            token,
            repository: config.github.repository,
            number,
            ...httpOptions(io),
          })
      : null,
    readReviewThreads: token
      ? async (number) =>
          (
            await fetchMergePull({
              token,
              repository: config.github.repository,
              number,
              ...httpOptions(io),
            })
          )?.reviewThreads ?? null
      : null,
    now: io.now ?? (() => new Date()),
  };
}

function print(io: Io, outcome: Outcome, json: boolean) {
  if (json) {
    io.stdout(`${JSON.stringify(outcome, null, 2)}\n`);
    return;
  }
  const out = [...outcome.lines];
  const s = outcome.state;
  if (s)
    out.push(
      `Now: ${s.status} · phase ${s.phase ?? "none"} · runtime ${s.runtime ?? "none"} · profile ${s.profile ?? "none"}`,
    );
  out.push(outcome.url);
  if (outcome.inbox) {
    if (!outcome.inbox.length) out.push("Inbox: nothing waiting for you.");
    else {
      out.push(`Inbox (${outcome.inbox.length}) — read and act on these:`);
      for (const item of outcome.inbox)
        out.push(
          `  #${item.id} ${item.kind}${item.author ? ` from ${item.author}` : ""} · ${item.createdAt}`,
          ...item.body.split("\n").map((l) => `    ${l}`),
        );
    }
  }
  io.stdout(`${out.join("\n")}\n`);
  for (const w of outcome.warnings) io.stderr(`armada: warning: ${w}\n`);
}

export interface WorkerArgs {
  rest: string[];
  options: Record<string, string>;
  json: boolean;
}

/** --message or --message-file (a path, or - for standard input); null when neither is given. */
export async function readMessage(
  io: Io,
  options: Record<string, string>,
  name: "message" | "plan" = "message",
): Promise<string | null> {
  const fileOption = `${name}-file`;
  if (options[name] !== undefined && options[fileOption] !== undefined)
    throw new UsageError(`pass --${name} or --${fileOption}, not both`);
  const file = options[fileOption];
  if (file === undefined) return options[name] ?? null;
  const text = file === "-" ? ((await io.readStdin?.()) ?? null) : await io.readFile(file);
  if (text === null) throw new UsageError(`cannot read the ${name} from ${file}`);
  if (!text.trim())
    throw new UsageError(
      `${file === "-" ? "standard input" : `${name} file ${file}`} is empty or whitespace-only`,
      `pass --${name} "<text>" or pipe a non-empty ${name} into --${fileOption} -`,
    );
  return text;
}

export async function withContext(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  json: boolean,
  act: (ctx: WorkerContext) => Promise<Outcome>,
): Promise<number> {
  const outcome = await act(workerContext(io, config, credentials));
  if (outcome.state?.phase) {
    const profile = outcome.state.profile;
    const agent = profile ? config.herdr.profiles[profile]?.harness : null;
    await reportHerdr(io, outcome.state.phase, agent ?? "armada");
  }
  print(io, outcome, json);
  return 0;
}

export async function claim(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  const [ticket, ...extra] = a.rest;
  if (!ticket) throw new UsageError("claim needs a ticket: armada claim <ticket> --runtime <name> --handle <id>");
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}`);
  const runtime = a.options.runtime?.trim();
  const handle = a.options.handle?.trim();
  if (!runtime) throw new UsageError("--runtime is required, e.g. --runtime conductor");
  const profile = a.options.profile?.trim() || null;
  const reason = a.options.reason?.trim() || null;
  if (reason && !profile)
    throw new UsageError("--reason goes with --profile: it says why the routed profile is not used");
  try {
    checkRequestedProfile(config, profile, a.options.runtime?.toLowerCase() === "herdr" ? "herdr" : "conductor");
  } catch (err) {
    if (err instanceof ProfileError) throw new UsageError(err.message);
    throw err;
  }
  if (!handle)
    throw new UsageError("--handle is required: the runtime's id for this session, e.g. <workspace>/<session>");
  let validation: ValidationChoice | null = null;
  if (a.options.validation !== undefined)
    try {
      validation = chooseValidations(config.policy.validations, {
        ticket: ticket.toUpperCase(),
        requested: a.options.validation,
        reason: a.options["validation-reason"] ?? null,
        command: `armada claim ${ticket.toUpperCase()} --runtime ${runtime} --handle ${handle}`,
      });
    } catch (err) {
      if (err instanceof ValidationChoiceError) throw new UsageError(err.message, err.next);
      throw err;
    }
  return withContext(io, config, credentials, a.json, (ctx) =>
    claimTicket(ctx, {
      ticket: ticket.toUpperCase(),
      runtime,
      handle,
      ...(a.options.branch ? { branch: a.options.branch } : {}),
      profile,
      reason,
      validation,
    }),
  );
}

export async function report(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  const [phase, ...extra] = a.rest;
  if (!phase || !isLabelPhase(phase))
    throw new UsageError(`report needs a phase: ${LABEL_PHASES.join(", ")}${phase ? ` (got "${phase}")` : ""}`);
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}`);
  if (a.options["message-file"] === "-" && a.options["plan-file"] === "-")
    throw new UsageError("--message-file - and --plan-file - both read standard input; give one of them a file");
  const message = await readMessage(io, a.options);
  const plan = await readMessage(io, a.options, "plan");
  if (!message?.trim() && !plan?.trim() && phase !== "ready-to-merge")
    throw new UsageError(
      "--message is required: what you did or what you are doing (first line = summary), or --plan-file with your plan",
    );
  const ticket = currentTicket(io, config, a.options.ticket, credentials.workerTickets);
  return withContext(io, config, credentials, a.json, (ctx) =>
    reportPhase(ctx, {
      ticket,
      phase,
      stage: a.options.stage ?? null,
      message,
      plan,
      ...(a.options.paths !== undefined ? { paths: a.options.paths.split(/[,\n]/).map((p) => p.trim()) } : {}),
      pr: a.options.pr ?? null,
      sha: a.options.sha ?? null,
      shippedWith: a.options["shipped-with"] ?? null,
    }),
  );
}

export async function release(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  if (a.rest.length) throw new UsageError(`unexpected argument ${a.rest[0]}`);
  const reason = a.options.reason?.trim();
  if (!reason) throw new UsageError("--reason is required: why the ticket is given back");
  const ticket = currentTicket(io, config, a.options.ticket, credentials.workerTickets);
  let claimedAt: string | null = null;
  const code = await withContext(io, config, credentials, a.json, async (ctx) => {
    const outcome = await releaseTicket(ctx, { ticket, reason });
    claimedAt = outcome.releasedClaim?.claimedAt ?? null;
    return outcome;
  });
  if (code === 0) await endWorkerSessions(io, config, credentials, ticket, "released", a.json, claimedAt);
  return code;
}

/**
 * Ends the ticket's worker sessions on Armada once it is released or merged:
 * a worker signs itself out and forgets its session; a signed-in coordinator
 * ends sessions launched by the released claim's time (all on merge). Not signed in, there is nothing to end. A
 * failure only warns: the session ends on its own when idle, and the Workers
 * page revokes it.
 */
export async function endWorkerSessions(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  ticket: string,
  reason: "released" | "merged",
  quiet: boolean,
  claimedAt?: string | null,
): Promise<void> {
  const signIn = credentials.armadaSignIn;
  if (!signIn) return;
  const api = apiOf(io, credentials.armadaApi.url);
  try {
    if (signIn.kind === "worker") {
      const paths = machinePaths(io.env);
      // Forgotten here first: the ticket is given back, whatever Armada answers.
      if (paths) await updateCredentialStore(paths, { [workerSessionVariable(signIn.ticket)]: null });
      await api.signOut(signIn);
      if (!quiet)
        io.stdout(`Signed out of Armada: the worker session of ${signIn.ticket} has ended.
`);
      return;
    }
    if (reason === "released" && !claimedAt) {
      io.stderr(`armada: warning: no release claim timestamp for ${ticket}; its worker sessions were kept on Armada
`);
      return;
    }
    const ended = await api.endWorkers(signIn, {
      project: config.project.slug,
      ticket,
      reason,
      ...(claimedAt ? { claimedAt } : {}),
    });
    if (ended && !quiet)
      io.stdout(`Ended ${ended === 1 ? "the worker session" : `${ended} worker sessions`} of ${ticket} on Armada.
`);
  } catch (err) {
    io.stderr(
      `armada: warning: the worker session of ${ticket} was not ended on Armada (${err instanceof Error ? err.message : String(err)}); it ends on its own after 72 hours without a command, and the Workers page revokes it\n`,
    );
  }
}
