// `armada ask | inbox | answer`: questions between a worker and the
// coordinator. Herdr and Conductor delivery is automatic; Claude Code uses the guide.
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
  RuntimeError,
  runtimeNameOf,
  secretNameRefusal,
  shellWord,
} from "@armada/core";
import { coordinatorName } from "./coordinator.ts";
import { type Io, UsageError } from "./io.ts";
import { requireSignIn } from "./login.ts";
import { detectCoordinator } from "./presence.ts";
import { deliverToRuntime, observingFleet } from "./runtime.ts";
import { claimRef, guarded, launchRef, runtimeFor } from "./runtimes/adapter.ts";
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
  let question = positional ?? fromOption;
  if (!question?.trim())
    throw new UsageError('ask needs a question: armada ask "<question, the options, your recommendation>"');
  const secret = a.options.secret;
  if (secret !== undefined) {
    if (secretNameRefusal(secret)) throw new UsageError("--secret takes a worker secret name in upper snake case");
    question = `Missing secret ${secret}: ${question}\nAsk the owner by link: armada secrets request ${secret} --ticket ${currentTicket(io, config, a.options.ticket, credentials.workerTickets)} --reason ${shellWord(question)}\nNever ask for the value in chat. When it is set, re-run with armada run -- <command>.`;
  }
  const options = (a.options.options ?? "")
    .split("|")
    .map((o) => o.trim())
    .filter(Boolean);
  const ticket = currentTicket(io, config, a.options.ticket, credentials.workerTickets);
  return withContext(io, config, credentials, a.json, (ctx, redact) =>
    askCoordinator(ctx, redact({ ticket, question, options })),
  );
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
  return withContext(io, config, credentials, a.json, (ctx, redact) =>
    answerItem(
      {
        ...ctx,
        deliversTo: (runtime) => !!runtimeNameOf(runtime) && runtimeFor(io, config, runtime).can.deliver,
        checkAnswerTarget: async ({ claim, launch }) => {
          const { fleet } = liveFleet(io, config, credentials);
          if (!fleet) throw new Refusal("cannot recheck the runtime generation before recording", "armada whoami");
          const ref = launch ? launchRef(launch) : claim ? claimRef(claim) : null;
          if (!ref) throw new Refusal("the runtime target is missing; no answer was recorded", "armada inbox");
          try {
            await guarded(fleet, ref, "active", async () => {});
          } catch (error) {
            if (error instanceof RuntimeError && error.code === "stale")
              throw new Refusal(
                "the worker generation changed after delivery; no further answer was recorded",
                "armada inbox",
              );
            throw error;
          }
        },
        deliverAnswer: async ({ ticket, text: maskedText, claim, launch, item, kind }) => {
          const { fleet } = liveFleet(io, config, credentials);
          if (!fleet) throw new Refusal("cannot read the runtime claim before delivery", "armada whoami");
          return deliverToRuntime(
            io,
            fleet,
            ticket,
            maskedText,
            claim,
            config,
            { kind, item, identityText: text.trim() },
            launch,
          );
        },
      },
      redact({ target, text, note }),
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
      'armada answer delivers to herdr and Conductor workers; for Claude Code deliver with the guide first, then record it: armada answer <id> "<answer>".',
    );
  if (
    items.some((e) =>
      ["answer-request", "launch-request", "merge-request", "release-request", "plan-changes"].includes(e.kind),
    )
  )
    out.push(
      'Dashboard requests: armada answer <id> "<answer>" delivers herdr and Conductor answer-requests automatically; for Claude Code deliver with the guide first; launch a launch-request (its claim resolves it), or decline it with armada answer <id> "<why>". A Merge press on a pull request handed back at its head arrives in the merge queue instead (keep armada merge --drain running); a merge-request is one the dashboard could not queue. Handle or decline merge-request, release-request and plan-changes, then resolve them with armada answer <id> "<result>". Plan changes are not an approval.',
    );
  if (items.some((e) => e.kind === "queue-stalled"))
    out.push(
      "Queued pull requests wait for a drain: run armada merge --drain in the background until the queue is empty.",
    );
  if (items.some((e) => e.kind === "queue-refused"))
    out.push(
      'A refused queue entry: fix what refused it, then queue it again (armada merge --when-green <pr>, or Merge on the dashboard), or record why not with armada answer <id> "<why>".',
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
    launchGraceMinutes: config.policy.launchGraceMinutes,
    ciWaitMinutes: config.policy.ciWaitMinutes,
    quietAfterMinutes: config.policy.quietAfterMinutes,
    notStartedMinutes: config.policy.notStartedMinutes,
    now: io.now ?? (() => new Date()),
    ...(wait
      ? { wait: { timeoutMs, sleep: io.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))) } }
      : {}),
  });
  const inFlight =
    name === "default" ? report.inFlight : (report.ownedInFlight ?? (scope === "mine" ? report.inFlight : null));
  const openJobs =
    name === "default" ? report.openJobs : (report.ownedOpenJobs ?? (scope === "mine" ? report.openJobs : undefined));
  await remember(io, report.project, shown(io, report.items, inFlight, openJobs, scope));
  const open = report.items.filter((e) => e.owner == null || e.owner === name).length;
  const next = await rearmFor(io, report.project, {
    inFlight,
    open,
    openJobs,
    act: open > 0,
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
