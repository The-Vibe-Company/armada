import { RequestRefused } from "./errors.ts";
import type { Journal } from "./journal.ts";
import type { RunnerRequest } from "./protocol.ts";

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
    return new Response(old.body, {
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
    const body = journal.redact(JSON.stringify({ error: error.message }));
    if (mutating) journal.db.query("INSERT OR REPLACE INTO requests VALUES(?,?)").run(request.requestId, body);
    return new Response(body, { status: 409, headers: { "content-type": "application/json" } });
  }
  // Event contents were masked by the journal with their protocol discriminators intact.
  if (request.op === "events") {
    const envelope = JSON.parse(journal.redact(JSON.stringify({ version: 1, requestId: request.requestId })));
    return Response.json({ ...envelope, result });
  }
  const body = journal.redact(JSON.stringify({ version: 1, requestId: request.requestId, result }));
  if (mutating) journal.db.query("INSERT OR REPLACE INTO requests VALUES(?,?)").run(request.requestId, body);
  return new Response(body, { headers: { "content-type": "application/json" } });
}
