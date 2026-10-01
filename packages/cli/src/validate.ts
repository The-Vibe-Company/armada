// `armada validate | ask-owner | done` (THE-885): what the owner validates on
// Armada's Validations page. A worker submits its own work (its phase becomes
// awaiting-validation); the coordinator sends a validation or a question for
// any ticket, and closes a ticket whose validation the owner approved.
import {
  type ArmadaConfig,
  type Credentials,
  closeValidated,
  createMissingLabels,
  parseChoices,
  readLabels,
  submitValidation,
} from "@armada/core";
import { attachItems } from "./attach.ts";
import { type Io, UsageError } from "./io.ts";
import { currentTicket, endWorkerSessions, readMessage, type WorkerArgs, withContext } from "./worker.ts";

const TICKET = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** `--attach` may be given several times; the parser keeps them one per line. */
export const attachList = (raw: string | undefined) =>
  (raw ?? "")
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean);

/**
 * The phase label `awaiting-validation` is newer than most projects' labels:
 * the first submission creates it, so no project needs `armada init` again.
 */
async function ensurePhaseLabel(io: Io, config: ArmadaConfig, credentials: Credentials): Promise<void> {
  const apiKey = credentials.linearApiKey;
  if (!apiKey) return;
  const opts = { apiKey, ...(io.fetch ? { fetch: io.fetch } : {}) };
  const state = await readLabels(config, opts);
  const groups = state.groups
    .filter((g) => g.name === config.tracker.labels.phaseGroup && g.id && g.missing.includes("awaiting-validation"))
    .map((g) => ({ ...g, missing: ["awaiting-validation"] }));
  if (groups.length) await createMissingLabels({ ...state, groups }, opts);
}

export async function validate(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  if (a.rest.length > 2) throw new UsageError(`unexpected argument ${a.rest[2]}; quote what to check`);
  const fromOption = await readMessage(io, a.options);
  // `validate <ticket> "<what>"`, `validate "<what>"`, or `validate <ticket> --message-file <path>`.
  const [first, second] = a.rest;
  const ticketArg = second !== undefined || (fromOption !== null && first && TICKET.test(first)) ? first : undefined;
  const positional = ticketArg === undefined ? first : second;
  if (positional !== undefined && fromOption !== null)
    throw new UsageError("give what to check once: as an argument, --message or --message-file");
  const what = positional ?? fromOption;
  if (!what?.trim())
    throw new UsageError('validate needs what the owner checks: armada validate "<what to check>" --attach <file|url>');
  const signIn = credentials.armadaSignIn;
  const ticket = ticketArg
    ? ticketArg.toUpperCase()
    : currentTicket(io, config, a.options.ticket, credentials.workerTickets);
  const worker = signIn?.kind === "worker";
  const items = attachList(a.options.attach);
  const attachments = items.length
    ? (
        await attachItems(io, config, credentials, {
          ticket,
          items,
          ...(a.options.caption ? { caption: a.options.caption } : {}),
          reference: "validation",
        })
      ).map((saved) => saved.attachment.id)
    : [];
  if (worker) await ensurePhaseLabel(io, config, credentials);
  return withContext(io, config, credentials, a.json, (ctx) =>
    submitValidation(ctx, {
      ticket,
      kind: "validation",
      what,
      choices: parseChoices(a.options.choices),
      attachments,
      worker,
    }),
  );
}

export async function askOwner(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  const [ticket, question, ...extra] = a.rest;
  const usage = 'armada ask-owner <ticket> "<question>" --choices "<a> | <b>"';
  if (!ticket || !TICKET.test(ticket)) throw new UsageError(`ask-owner needs a ticket: ${usage}`);
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}; quote the question`);
  if (!question?.trim()) throw new UsageError(`ask-owner needs the question: ${usage}`);
  const choices = parseChoices(a.options.choices);
  if (!choices || choices.length < 2) throw new UsageError(`give the owner at least two choices: ${usage}`);
  if (credentials.armadaSignIn?.kind === "worker")
    throw new UsageError("a worker asks the coordinator (armada ask), who escalates to the owner");
  return withContext(io, config, credentials, a.json, (ctx) =>
    submitValidation(ctx, {
      ticket: ticket.toUpperCase(),
      kind: "question",
      what: question,
      choices,
      attachments: [],
      worker: false,
    }),
  );
}

export async function done(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  const [ticket, ...extra] = a.rest;
  if (!ticket || !TICKET.test(ticket)) throw new UsageError("done needs a ticket: armada done <ticket>");
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}`);
  if (credentials.armadaSignIn?.kind === "worker")
    throw new UsageError("workers never close their ticket: the coordinator runs armada done");
  const id = ticket.toUpperCase();
  const base = credentials.armadaApi.url;
  const code = await withContext(io, config, credentials, a.json, (ctx) =>
    closeValidated(ctx, {
      ticket: id,
      attachmentUrl: (attachment) =>
        new URL(`/agents/${encodeURIComponent(id)}?tab=attachments&attachment=${attachment}`, base).toString(),
    }),
  );
  await endWorkerSessions(io, config, credentials, id, "merged", a.json);
  return code;
}
