import { createHash } from "node:crypto";
import type { Journal } from "./journal.ts";
import { groupState, type ProcessIdentity } from "./processes.ts";
import type { Grant } from "./protocol.ts";

interface RuntimeObservation {
  journal: Journal;
  grant: Grant;
  barrier: boolean;
  active: Pick<ReadonlyMap<string, unknown>, "size" | "keys">;
  commands: Pick<ReadonlySet<unknown>, "size">;
  conversationId: string | undefined;
}

/** Read-only evidence: incomplete checkpoints, process identity or ingest ACKs stay unknown. */
export function observeRuntime({ journal, grant, barrier, active, commands, conversationId }: RuntimeObservation) {
  const watermark = Number(
    (journal.db.query("SELECT coalesce(max(seq),0) AS watermark FROM events").get() as { watermark: number }).watermark,
  );
  let state: "active" | "quiescent" | "unknown" = barrier || journal.checkpointPending(grant) ? "unknown" : "quiescent";
  const processes: Array<{ pid: number; state: string }> = [];
  for (const row of journal.db.query("SELECT pid,body FROM processes").all() as {
    pid: number;
    body: string;
  }[]) {
    const saved = JSON.parse(row.body) as { status: string; identity?: ProcessIdentity };
    if (!["running", "running_after_restart", "unknown_after_restart"].includes(saved.status)) continue;
    const status = groupState(row.pid, saved.identity);
    processes.push({ pid: row.pid, state: status });
    if (status === "unverifiable") state = "unknown";
    else if (status === "live" && state !== "unknown") state = "active";
  }
  if ((active.size > 0 || commands.size > 0) && state !== "unknown") state = "active";
  const acknowledgedSequence = journal.ack;
  if (state === "quiescent" && acknowledgedSequence < watermark) state = "unknown";
  const evidence = createHash("sha256")
    .update(
      JSON.stringify({
        generation: grant.generation,
        watermark,
        acknowledgedSequence,
        active: [...active.keys()].sort(),
        commands: commands.size,
        processes,
      }),
    )
    .digest("hex");
  return {
    physicalGeneration: grant.generation,
    state,
    evidence,
    eventWatermark: watermark,
    acknowledgedSequence,
    nativeSessionId: conversationId ? (journal.session(conversationId) ?? null) : null,
  };
}
