// `armada claim | report | release`: how a worker tells the fleet where it is.
// Linear is written through the one write adapter; Turso is optional and a
// failure there only warns.
import {
  type ArmadaConfig,
  type Credentials,
  checkRequestedProfile,
  claimTicket,
  createLinearWriter,
  type Db,
  fetchPullRequest,
  isLabelPhase,
  LABEL_PHASES,
  LINEAR_KEY,
  lastEventTimes,
  type Outcome,
  openTurso,
  ProfileError,
  releaseTicket,
  reportPhase,
  ticketFromBranch,
  type WorkerContext,
} from "@armada/core";
import { type Io, missingKey, UsageError } from "./io.ts";

const TURSO_OPEN_TIMEOUT_MS = 10_000;

/** Opens Turso when configured; any problem becomes a warning, never a failure. */
export async function openLive(credentials: Credentials): Promise<{ db: Db | null; warning: string | null }> {
  if (!credentials.tursoUrl)
    return { db: null, warning: "Turso is not configured (ARMADA_TURSO_URL); live activity is not recorded" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const opening = openTurso({ url: credentials.tursoUrl, token: credentials.tursoToken });
  try {
    const db = await Promise.race([
      opening,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${TURSO_OPEN_TIMEOUT_MS / 1000} s`)),
          TURSO_OPEN_TIMEOUT_MS,
        );
      }),
    ]);
    return { db, warning: null };
  } catch (err) {
    // A connection that opens after the timeout is closed, not leaked.
    opening.then(
      (db) => db.close(),
      () => {},
    );
    const reason = err instanceof Error ? err.message : String(err);
    return { db: null, warning: `Turso unavailable (${reason}); live activity is not recorded, Linear is` };
  } finally {
    clearTimeout(timer);
  }
}

/** Newest Turso event per ticket for `armada status`; undefined when Turso is not configured. */
export function statusEvents(
  config: ArmadaConfig,
  credentials: Credentials,
): (() => Promise<Record<string, string>>) | undefined {
  if (!credentials.tursoUrl) return undefined;
  return async () => {
    const { db, warning } = await openLive(credentials);
    if (!db) throw new Error(warning ?? "Turso unavailable");
    try {
      return await lastEventTimes(db, config.project.slug);
    } finally {
      db.close();
    }
  };
}

/** --ticket, then ARMADA_TICKET, then the current git branch. */
export function currentTicket(io: Io, config: ArmadaConfig, explicit: string | undefined): string {
  const fromEnv = io.env.ARMADA_TICKET?.trim();
  const id =
    explicit?.trim() ||
    fromEnv ||
    (() => {
      const branch = io.gitBranch?.();
      return branch ? ticketFromBranch(branch, config.tracker.programRoot) : null;
    })();
  if (!id) throw new UsageError("which ticket? pass --ticket <id>, set ARMADA_TICKET, or run on the ticket's branch");
  return id.toUpperCase();
}

async function context(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
): Promise<{ ctx: WorkerContext; close: () => Promise<void> }> {
  if (!credentials.linearApiKey) throw missingKey(LINEAR_KEY);
  const linearOpts = {
    apiKey: credentials.linearApiKey,
    labels: config.tracker.labels,
    ...(io.fetch ? { fetch: io.fetch } : {}),
  };
  const linear = io.linearWriter ? io.linearWriter(linearOpts) : createLinearWriter(linearOpts);
  // Turso is opened only when a command reaches its Turso step, after Linear.
  let live: ReturnType<typeof openLive> | null = null;
  const token = credentials.githubToken;
  const ctx: WorkerContext = {
    config,
    linear,
    turso: () => {
      live ??= openLive(credentials);
      return live;
    },
    readPull: token
      ? (number) =>
          fetchPullRequest({
            token,
            repository: config.github.repository,
            number,
            ...(io.fetch ? { fetch: io.fetch } : {}),
          })
      : null,
    now: io.now ?? (() => new Date()),
  };
  const close = async () => {
    const opened = await live;
    opened?.db?.close();
  };
  return { ctx, close };
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
export async function readMessage(io: Io, options: Record<string, string>): Promise<string | null> {
  if (options.message !== undefined && options["message-file"] !== undefined)
    throw new UsageError("pass --message or --message-file, not both");
  const file = options["message-file"];
  if (file === undefined) return options.message ?? null;
  const text = file === "-" ? ((await io.readStdin?.()) ?? null) : await io.readFile(file);
  if (text === null) throw new UsageError(`cannot read the message from ${file}`);
  return text;
}

export async function withContext(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  json: boolean,
  act: (ctx: WorkerContext) => Promise<Outcome>,
): Promise<number> {
  const { ctx, close } = await context(io, config, credentials);
  try {
    print(io, await act(ctx), json);
    return 0;
  } finally {
    await close();
  }
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
    checkRequestedProfile(config, profile);
  } catch (err) {
    if (err instanceof ProfileError) throw new UsageError(err.message);
    throw err;
  }
  if (!handle)
    throw new UsageError("--handle is required: the runtime's id for this session, e.g. <workspace>/<session>");
  return withContext(io, config, credentials, a.json, (ctx) =>
    claimTicket(ctx, {
      ticket: ticket.toUpperCase(),
      runtime,
      handle,
      ...(a.options.branch ? { branch: a.options.branch } : {}),
      profile,
      reason,
    }),
  );
}

export async function report(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  const [phase, ...extra] = a.rest;
  if (!phase || !isLabelPhase(phase))
    throw new UsageError(`report needs a phase: ${LABEL_PHASES.join(", ")}${phase ? ` (got "${phase}")` : ""}`);
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}`);
  const message = await readMessage(io, a.options);
  if (!message?.trim() && phase !== "ready-to-merge")
    throw new UsageError("--message is required: what you did or what you are doing (first line = summary)");
  const ticket = currentTicket(io, config, a.options.ticket);
  return withContext(io, config, credentials, a.json, (ctx) =>
    reportPhase(ctx, {
      ticket,
      phase,
      message,
      pr: a.options.pr ?? null,
      sha: a.options.sha ?? null,
    }),
  );
}

export async function release(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  if (a.rest.length) throw new UsageError(`unexpected argument ${a.rest[0]}`);
  const reason = a.options.reason?.trim();
  if (!reason) throw new UsageError("--reason is required: why the ticket is given back");
  const ticket = currentTicket(io, config, a.options.ticket);
  return withContext(io, config, credentials, a.json, (ctx) => releaseTicket(ctx, { ticket, reason }));
}
