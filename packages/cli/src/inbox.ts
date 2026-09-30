// `armada ask | inbox | answer`: questions between a worker and the
// coordinator. Armada only records: the coordinator delivers every answer in
// the worker's session through the runtime guide.
import {
  type ArmadaConfig,
  answerItem,
  askCoordinator,
  type Credentials,
  checkInbox,
  type InboxReport,
  Refusal,
} from "@armada/core";
import { type Io, UsageError } from "./io.ts";
import { currentTicket, openLive, readMessage, type WorkerArgs, withContext } from "./worker.ts";

/** Default for `armada inbox --wait`: short enough for an agent's command time limit. */
export const DEFAULT_WAIT_SECONDS = 300;

export async function ask(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  const [positional, ...extra] = a.rest;
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}; quote the question`);
  const fromOption = await readMessage(io, a.options);
  if (positional !== undefined && fromOption !== null)
    throw new UsageError("give the question once: as an argument, --message or --message-file");
  const question = positional ?? fromOption;
  if (!question?.trim())
    throw new UsageError('ask needs a question: armada ask "<question, the options, your recommendation>"');
  const options = (a.options.options ?? "")
    .split("|")
    .map((o) => o.trim())
    .filter(Boolean);
  const ticket = currentTicket(io, config, a.options.ticket, credentials.workerTickets);
  return withContext(io, config, credentials, a.json, (ctx) => askCoordinator(ctx, { ticket, question, options }));
}

export async function answer(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  const note = a.options.note === "true";
  const [target, positional, ...extra] = a.rest;
  const usage = note ? 'armada answer --note <ticket> "<message>"' : 'armada answer <item or ticket> "<answer>"';
  if (!target) throw new UsageError(`answer needs a target: ${usage}`);
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}; quote the ${note ? "message" : "answer"}`);
  const fromOption = await readMessage(io, a.options);
  if (positional !== undefined && fromOption !== null)
    throw new UsageError("give the text once: as an argument, --message or --message-file");
  const text = positional ?? fromOption;
  if (!text?.trim()) throw new UsageError(`answer needs the text: ${usage}`);
  return withContext(io, config, credentials, a.json, (ctx) => answerItem(ctx, { target, text, note }));
}

function waitSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WAIT_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--timeout must be a number of seconds, got "${raw}"`);
  return n;
}

export function renderInbox(r: InboxReport): string {
  const out: string[] = [];
  if (!r.items.length) out.push(`Inbox of ${r.project}: nothing waits for you.`);
  else {
    out.push(`Inbox of ${r.project} (${r.items.length}), oldest first:`);
    for (const e of r.items) {
      const head = [
        e.id === null ? e.kind : `#${e.id} ${e.kind}`,
        e.ticket,
        e.author && `from ${e.author}`,
        e.request?.question && `answers #${e.request.question}`,
        e.request?.profile && `profile ${e.request.profile}`,
        e.createdAt,
      ]
        .filter(Boolean)
        .join(" · ");
      out.push(`${e.new ? "* " : "  "}${head}`, ...e.body.split("\n").map((l) => (l ? `    ${l}` : "")));
    }
    if (r.items.some((e) => e.kind === "question" || e.kind === "plan"))
      out.push(
        'Deliver each answer in the worker\'s session with the runtime guide, then record it: armada answer <id> "<answer>".',
      );
    if (r.items.some((e) => e.kind === "answer-request" || e.kind === "launch-request"))
      out.push(
        'Dashboard requests: deliver an answer-request, then armada answer <id> "<answer>"; launch a launch-request (its claim resolves it), or decline it with armada answer <id> "<why>".',
      );
  }
  if (r.wait?.timedOut) out.push(`No new item within ${r.wait.timeoutSeconds} s.`);
  else if (r.wait) out.push("New items are marked *.");
  return `${out.join("\n")}\n`;
}

/** Reads Turso only: no Linear key needed, cheap enough to run in a loop. */
export async function inbox(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  if (a.rest.length) throw new UsageError(`unexpected argument ${a.rest[0]}`);
  const wait = a.options.wait === "true";
  if (!wait && a.options.timeout !== undefined) throw new UsageError("--timeout applies to --wait");
  const timeoutMs = waitSeconds(a.options.timeout) * 1000;
  if (!credentials.tursoUrl)
    throw new UsageError("the inbox lives in Turso: set ARMADA_TURSO_URL", "armada auth login");
  const { db, warning } = await openLive(credentials);
  if (!db)
    throw new Refusal(
      `the inbox lives in Turso, which is unavailable: ${warning ?? "no answer"}`,
      "armada inbox again once Turso answers (armada auth status shows the URL in use)",
    );
  try {
    const workspace = io.env.CONDUCTOR_WORKSPACE_ID?.trim();
    const session = io.env.CONDUCTOR_SESSION_ID?.trim();
    const coordinator =
      io.env.ARMADA_COORDINATOR_HANDLE?.trim() || (workspace && session ? `${workspace}/${session}` : null);
    const report = await checkInbox(db, {
      project: config.project.slug,
      coordinator,
      silentAfterMinutes: config.policy.silentAfterMinutes,
      now: io.now ?? (() => new Date()),
      ...(wait
        ? { wait: { timeoutMs, sleep: io.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))) } }
        : {}),
    });
    io.stdout(a.json ? `${JSON.stringify(report, null, 2)}\n` : renderInbox(report));
    for (const w of report.warnings) io.stderr(`armada: warning: ${w}\n`);
    return 0;
  } finally {
    db.close();
  }
}
