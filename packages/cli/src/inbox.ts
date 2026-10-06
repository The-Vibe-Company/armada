// `armada ask | inbox | answer`: questions between a worker and the
// coordinator. Local herdr delivery is automatic; other runtimes use the guide.
import {
  type ArmadaConfig,
  answerItem,
  askCoordinator,
  type Credentials,
  checkInbox,
  freshRuntimeState,
  type InboxEntry,
  type InboxReport,
  type Rearm,
  Refusal,
} from "@armada/core";
import { coordinatorName } from "./coordinator.ts";
import { type Io, UsageError } from "./io.ts";
import { requireSignIn } from "./login.ts";
import { detectCoordinator } from "./presence.ts";
import { deliverToRuntime, observingFleet } from "./runtime.ts";
import { coordinatorHandle, rearmFor, remember, shown } from "./watch.ts";
import { currentTicket, liveFleet, readMessage, type WorkerArgs, withContext } from "./worker.ts";

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
  return withContext(io, config, credentials, a.json, (ctx) =>
    answerItem(
      {
        ...ctx,
        deliverAnswer: async (ticket, message, runtime, claim) => {
          if (runtime && runtime.toLowerCase() !== "herdr") return false;
          const { fleet } = liveFleet(io, config, credentials);
          if (!fleet) {
            if (runtime?.toLowerCase() === "herdr")
              throw new Refusal("cannot read the herdr claim before delivery", "armada whoami");
            return false;
          }
          const delivered = await deliverToRuntime(io, fleet, ticket, message, claim, config, {
            kind: note ? "note" : "answer",
            item: /^\d+$/.test(target) ? Number(target) : null,
          });
          if (!delivered && runtime?.toLowerCase() === "herdr")
            throw new Refusal("the herdr claim is missing or changed; no answer was delivered", "armada status");
          return delivered;
        },
      },
      { target, text, note },
    ),
  );
}

function waitSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WAIT_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--timeout must be a number of seconds, got "${raw}"`);
  return n;
}

/** The entries of an inbox, oldest first, with what to do about them; new ones marked *. */
export function renderEntries(project: string, items: InboxEntry[]): string[] {
  if (!items.length) return [`Inbox of ${project}: nothing waits for you.`];
  const out = [`Inbox of ${project} (${items.length}), oldest first:`];
  for (const e of items) {
    const head = [
      e.id === null ? e.kind : `#${e.id} ${e.kind}`,
      e.ticket,
      e.owner ? `owner: ${e.owner}` : "unowned",
      e.author && `from ${e.author}`,
      e.request?.question && `${e.kind === "plan-changes" ? "amends" : "answers"} #${e.request.question}`,
      e.request?.profile && `profile ${e.request.profile}`,
      e.request?.pr && `PR #${e.request.pr}`,
      e.createdAt,
    ]
      .filter(Boolean)
      .join(" · ");
    out.push(`${e.new ? "* " : "  "}${head}`, ...e.body.split("\n").map((l) => (l ? `    ${l}` : "")));
    if (e.kind === "hand-back" && !/shipped with (?:ship-pr-dev|the fallback:)|shipping path unreported/.test(e.body))
      out.push("    shipping path unreported");
  }
  if (items.some((e) => e.kind === "runtime-blocked"))
    out.push('Read the blocked herdr pane with its runtime guide, then answer: armada answer <ticket> "<answer>".');
  if (items.some((e) => e.kind === "question" || e.kind === "plan"))
    out.push(
      'For herdr, armada answer delivers automatically. Deliver each other answer in the worker\'s session with the runtime guide, then record it: armada answer <id> "<answer>".',
    );
  if (
    items.some((e) =>
      ["answer-request", "launch-request", "merge-request", "release-request", "plan-changes"].includes(e.kind),
    )
  )
    out.push(
      'Dashboard requests: armada answer <id> "<answer>" delivers herdr answer-requests automatically; deliver answers for other runtimes first; launch a launch-request (its claim resolves it), or decline it with armada answer <id> "<why>". Handle or decline merge-request, release-request and plan-changes, then resolve them with armada answer <id> "<result>". Plan changes are not an approval.',
    );
  return out;
}

export function renderInbox(r: InboxReport, next: Rearm): string {
  const out = renderEntries(r.project, r.items);
  if (r.wait?.timedOut) out.push(`No new item within ${r.wait.timeoutSeconds} s.`);
  else if (r.wait) out.push("New items are marked *.");
  out.push(next.line);
  return `${out.join("\n")}\n`;
}

/** Reads the inbox through Armada only: no Linear key needed, cheap enough to run in a loop. */
export async function inbox(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  if (a.rest.length) throw new UsageError(`unexpected argument ${a.rest[0]}`);
  const name = await coordinatorName(io, config.project.slug);
  const scope = a.options.mine ? "mine" : "all";
  const wait = a.options.wait === "true";
  if (!wait && a.options.timeout !== undefined) throw new UsageError("--timeout applies to --wait");
  const timeoutMs = waitSeconds(a.options.timeout) * 1000;
  requireSignIn(credentials);
  const { fleet, warning } = liveFleet(io, config, credentials);
  if (!fleet)
    throw new Refusal(`the inbox is on Armada, which cannot be reached: ${warning ?? "no answer"}`, "armada whoami");
  const report = await checkInbox(observingFleet(io, fleet, config), {
    project: config.project.slug,
    scope,
    coordinatorName: name,
    coordinator: coordinatorHandle(io),
    facts: detectCoordinator(io),
    silentAfterMinutes: config.policy.silentAfterMinutes,
    quietAfterMinutes: config.policy.quietAfterMinutes,
    notStartedMinutes: config.policy.notStartedMinutes,
    now: io.now ?? (() => new Date()),
    ...(wait
      ? { wait: { timeoutMs, sleep: io.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))) } }
      : {}),
  });
  const inFlight =
    name === "default" ? report.inFlight : (report.ownedInFlight ?? (scope === "mine" ? report.inFlight : null));
  await remember(io, report.project, shown(io, report.items, inFlight));
  const next = await rearmFor(io, report.project, {
    inFlight,
    open: report.items.length,
    act: report.items.length > 0,
  });
  const runtimes = (await fleet.runtimeHandles().catch(() => []))
    .filter((h) => h.runtimeState && (scope === "all" || h.coordinator === name))
    .map((h) => ({
      ticket: h.ticket,
      runtime: h.runtime,
      state:
        freshRuntimeState(
          h.runtimeState,
          (io.now ?? (() => new Date()))(),
          config.policy.silentAfterMinutes,
          h.claimedAt,
        ) ?? "unknown",
    }));
  io.stdout(
    a.json
      ? `${JSON.stringify({ ...report, runtimes, watch: next }, null, 2)}\n`
      : renderInbox(report, next).replace(
          next.line,
          `${runtimes.map((h) => `${h.ticket} · ${h.runtime} · live ${h.state}`).join("\n")}${runtimes.length ? "\n" : ""}${next.line}`,
        ),
  );
  for (const w of report.warnings) io.stderr(`armada: warning: ${w}\n`);
  return 0;
}
