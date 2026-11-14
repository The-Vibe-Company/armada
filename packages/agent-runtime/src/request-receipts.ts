import type { Journal } from "./journal.ts";
import type { RunnerRequest } from "./protocol.ts";

const READ_ONLY_OPERATIONS = new Set(["events", "health", "getPrompt", "getExec", "checkpoint", "observeOrchestrator"]);

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
    return new Response(old.body, { headers: { "content-type": "application/json" } });
  const mutating = !READ_ONLY_OPERATIONS.has(request.op);
  // Fence before side effects. A crash leaves an explicit unknown outcome, never a duplicate turn.
  if (mutating)
    journal.db
      .query("INSERT INTO requests VALUES(?,?)")
      .run(
        request.requestId,
        JSON.stringify({ version: 1, requestId: request.requestId, error: "request_outcome_unknown" }),
      );
  const result = await dispatch();
  const body = journal.redact(JSON.stringify({ version: 1, requestId: request.requestId, result }));
  if (mutating) journal.db.query("INSERT OR REPLACE INTO requests VALUES(?,?)").run(request.requestId, body);
  return new Response(body, { headers: { "content-type": "application/json" } });
}
