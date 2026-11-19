import { type AgentEvent, truncateEvent } from "@armada/core";
import { commandOutputLimit } from "./command-output.ts";
import { RequestRefused } from "./errors.ts";
import type { Journal } from "./journal.ts";
import { MAX_COMMAND_RESPONSE_BYTES, type RunnerRequest } from "./protocol.ts";
import type { executeWorkspace } from "./workspace-exec.ts";

export interface EventSelection {
  after: number;
  rows: ReturnType<Journal["events"]>;
  hasMore: boolean;
}

const READ_ONLY_OPERATIONS = new Set(["events", "health", "getPrompt", "getExec", "checkpoint", "observeOrchestrator"]);

/** A stored definite refusal replays as 409; only genuine uncertainty replays as 200. */
function replayStatus(body: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 200;
  }
  return parsed !== null &&
    typeof parsed === "object" &&
    "error" in parsed &&
    (parsed as { error: unknown }).error !== "request_outcome_unknown"
    ? 409
    : 200;
}

/** Preserve uncertain mutation outcomes across crashes; never dispatch a replay twice. */
export async function executeWithReceipt(
  journal: Journal,
  request: RunnerRequest,
  dispatch: () => Promise<unknown>,
): Promise<Response> {
  const old = journal.db.query("SELECT body FROM requests WHERE id=?").get(request.requestId) as {
    body: string;
  } | null;
  if (old && request.op !== "checkpoint")
    return new Response(journal.redact(old.body, "requests"), {
      status: replayStatus(old.body),
      headers: { "content-type": "application/json" },
    });
  const mutating = !READ_ONLY_OPERATIONS.has(request.op);
  // Fence before side effects. A crash leaves an explicit unknown outcome, never a duplicate turn.
  if (mutating)
    journal.db
      .query("INSERT INTO requests VALUES(?,?)")
      .run(
        request.requestId,
        JSON.stringify({ version: 1, requestId: request.requestId, error: "request_outcome_unknown" }),
      );
  let result: unknown;
  try {
    result = await dispatch();
  } catch (error) {
    if (!(error instanceof RequestRefused)) throw error;
    const body = journal.redact(JSON.stringify({ error: error.message }), "requests");
    if (mutating) journal.db.query("INSERT OR REPLACE INTO requests VALUES(?,?)").run(request.requestId, body);
    return new Response(body, { status: 409, headers: { "content-type": "application/json" } });
  }
  if (request.op === "events") return eventsResponse(journal, request.requestId, result as EventSelection);
  const body =
    request.op === "workspaceExec"
      ? workspaceReceipt(journal, request.requestId, result as Awaited<ReturnType<typeof executeWorkspace>>)
      : journal.redact(JSON.stringify({ version: 1, requestId: request.requestId, result }), "requests");
  if (mutating) journal.db.query("INSERT OR REPLACE INTO requests VALUES(?,?)").run(request.requestId, body);
  return new Response(body, { headers: { "content-type": "application/json" } });
}

function responseEnvelope(journal: Journal, requestId: string): { version: 1; requestId: string } {
  return JSON.parse(journal.redact(JSON.stringify({ version: 1, requestId }), "requests"));
}

function eventsResponse(journal: Journal, requestId: string, selection: EventSelection) {
  const envelope = responseEnvelope(journal, requestId);
  const page = { events: [] as AgentEvent[], cursor: String(selection.after), hasMore: selection.hasMore };
  let eventsBytes = 0;
  for (const [index, row] of selection.rows.entries()) {
    const cursor = String(row.sequence);
    const hasMore = selection.hasMore || index + 1 < selection.rows.length;
    const envelopeBytes = Buffer.byteLength(JSON.stringify({ ...envelope, result: { events: [], cursor, hasMore } }));
    let event = journal.redactEvent(row.event);
    let bytes = Buffer.byteLength(JSON.stringify(event));
    if (envelopeBytes + eventsBytes + bytes + page.events.length > MAX_COMMAND_RESPONSE_BYTES) {
      if (page.events.length) break;
      event = truncateEvent(event, bytes);
      bytes = Buffer.byteLength(JSON.stringify(event));
    }
    page.events.push(event);
    eventsBytes += bytes;
    page.cursor = cursor;
    page.hasMore = hasMore;
  }
  const body = JSON.stringify({ ...envelope, result: page });
  if (Buffer.byteLength(body) > MAX_COMMAND_RESPONSE_BYTES) throw Error("invalid_request");
  return new Response(body, { headers: { "content-type": "application/json" } });
}

function workspaceReceipt(journal: Journal, requestId: string, output: Awaited<ReturnType<typeof executeWorkspace>>) {
  const stdout = journal.redactCommandOutput(output.stdout, commandOutputLimit);
  const stderr = journal.redactCommandOutput(output.stderr, commandOutputLimit);
  return JSON.stringify({
    ...responseEnvelope(journal, requestId),
    result: {
      detached: false,
      exitCode: output.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      timedOut: output.timedOut,
    },
  });
}
