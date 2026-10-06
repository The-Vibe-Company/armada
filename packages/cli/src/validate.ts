// `armada validate | ask-owner | done` (THE-885): what the owner validates on
// Armada's Validations page. A worker submits its own work (its phase becomes
// awaiting-validation); the coordinator sends a validation or a question for
// any ticket, and closes a ticket whose validation the owner approved.

import { basename, resolve } from "node:path";
import {
  type ArmadaConfig,
  type Credentials,
  closeValidated,
  createMissingLabels,
  excerptLines,
  parseChoices,
  readLabels,
  redactSecrets,
  submitValidation,
} from "@armada/core";
import { attachItems } from "./attach.ts";
import { httpOptions, type Io, UsageError } from "./io.ts";
import { currentTicket, endWorkerSessions, readMessage, type WorkerArgs, withContext } from "./worker.ts";

/** A local text sample, with an optional inclusive, one-based line range. */
export async function readExcerpt(io: Io, raw: string) {
  const match = /^(.*):(\d+)-(\d+)$/.exec(raw);
  const file = match?.[1] ?? raw;
  const from = match ? Number(match[2]) : 1;
  const to = match ? Number(match[3]) : null;
  const usage = `armada validate "<headline>" --excerpt '${file.replaceAll("'", "'\\''")}':1-40`;
  if (!file || !Number.isSafeInteger(from) || from < 1 || (to !== null && (!Number.isSafeInteger(to) || to < from)))
    throw new UsageError(`--excerpt needs <file>[:from-to], with a one-based inclusive range: ${usage}`);
  const text = await io.readFile(resolve(io.cwd, file));
  if (text === null) throw new UsageError(`cannot read excerpt file: ${file}`);
  const lines = excerptLines(text);
  if (from > lines.length || (to !== null && to > lines.length))
    throw new UsageError(`excerpt range exceeds ${lines.length} lines: ${usage}`);
  return {
    label: `${basename(file)}${match ? `:${from}-${to}` : ""}`,
    text: lines.slice(from - 1, to ?? undefined).join("\n"),
  };
}

async function validationFiles(io: Io, options: Record<string, string>, secrets: string[]) {
  const excerpts = (await Promise.all(attachList(options.excerpt).map((raw) => readExcerpt(io, raw)))).map(
    ({ label, text }) => ({ label: redactSecrets(label, secrets), text: redactSecrets(text, secrets) }),
  );
  const file = options["details-file"];
  const details = file ? await io.readFile(resolve(io.cwd, file)) : null;
  if (file && details === null) throw new UsageError(`cannot read details file: ${file}`);
  return { excerpts, details: details === null ? null : redactSecrets(details, secrets) };
}

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
  const opts = { apiKey, ...httpOptions(io) };
  const state = await readLabels(config, opts);
  const groups = state.groups
    .filter((g) => g.name === config.tracker.labels.phaseGroup && g.id && g.missing.includes("awaiting-validation"))
    .map((g) => ({ ...g, missing: ["awaiting-validation"] }));
  if (groups.length) await createMissingLabels({ ...state, groups, labels: [] }, opts);
}

/**
 * The ticket `validate` names as its first argument: `validate <ticket> "<what>"`,
 * or `validate <ticket> --message-file <path>`. That is the coordinator's form,
 * signed in as the terminal; without it (`validate "<what>"`) a worker submits
 * its own work, signed in with its ticket's session.
 */
export function namedTicket(rest: string[], options: Record<string, string>): string | null {
  const [first, second] = rest;
  const fromOption = options.message !== undefined || options["message-file"] !== undefined;
  if (first && (second !== undefined || (fromOption && TICKET.test(first)))) return first.toUpperCase();
  return null;
}

export async function validate(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  if (a.rest.length > 2) throw new UsageError(`unexpected argument ${a.rest[2]}; quote what to check`);
  const named = namedTicket(a.rest, a.options);
  const positional = named ? a.rest[1] : a.rest[0];
  const fromOption = await readMessage(io, a.options);
  if (positional !== undefined && fromOption !== null)
    throw new UsageError("give what to check once: as an argument, --message or --message-file");
  const what = positional ?? fromOption;
  if (!what?.trim())
    throw new UsageError('validate needs what the owner checks: armada validate "<what to check>" --attach <file|url>');
  if (named && !TICKET.test(named)) throw new UsageError(`"${named}" is not a ticket id such as ABC-12`);
  const ticket = named ?? currentTicket(io, config, a.options.ticket, credentials.workerTickets);
  const worker = !named && credentials.armadaSignIn?.kind === "worker";
  const items = attachList(a.options.attach);
  const secrets = [
    credentials.armadaSignIn?.kind === "api-key" ? credentials.armadaSignIn.key : credentials.armadaSignIn?.token,
    credentials.linearApiKey,
    credentials.githubToken,
    ...config.secrets.names.map((name) => io.env[name]),
  ].filter((value): value is string => !!value);
  const samples = await validationFiles(io, a.options, secrets);
  if (worker) await ensurePhaseLabel(io, config, credentials);
  return withContext(io, config, credentials, a.json, (ctx) =>
    submitValidation(ctx, {
      ticket,
      kind: "validation",
      what,
      checks: attachList(a.options.check),
      ...samples,
      uploadCount: items.length,
      choices: parseChoices(a.options.choices),
      attachments: [],
      // Uploaded once every check passed: a refused submission leaves nothing behind.
      upload: async () =>
        items.length
          ? (
              await attachItems(io, config, credentials, {
                ticket,
                items,
                ...(a.options.caption ? { caption: a.options.caption } : {}),
                reference: "validation",
              })
            ).map((saved) => saved.attachment.id)
          : [],
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
      checks: attachList(a.options.check),
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
