import { type AgentEvent, decryptSecret, encryptSecret, isFinalPromptStatus, type Sql } from "@armada/core/server";

/** Called only inside event admission's sandbox/epoch transaction. Existing archives
 * are projected once, in bounded pages; sweeps never decrypt historical events.
 * The watermark survives resume and is never reset with the enrolment epoch. */
export async function projectRuntimeIdle(
  tx: Sql,
  id: string,
  key: string,
  archiveSequence: number,
  fresh: readonly AgentEvent[],
  sequence: number,
) {
  await tx.query("insert into public.runtime_idle_evidence(sandbox_id) values($1) on conflict do nothing", [id]);
  const state = (
    await tx.query<{ sequence: string }>(
      "select least(sequence,prompt_projection_sequence)::text as sequence from public.runtime_idle_evidence where sandbox_id=$1 for update",
      [id],
    )
  ).rows[0];
  let cursor = Number(state?.sequence ?? 0);
  async function apply(events: readonly AgentEvent[], watermark: number) {
    let last = 0;
    let unknown = false;
    const turns = new Map<string, boolean>();
    for (const event of events) {
      last = Math.max(last, event.at);
      if (event.kind === "prompt") {
        if (!event.promptId) unknown = true;
        else turns.set(event.promptId, isFinalPromptStatus(event.status));
      }
    }
    const references = [...new Set(events.flatMap((event) => (event.promptId ? [event.promptId] : [])))];
    if (references.length)
      await tx.query(
        `insert into public.runtime_idle_turns(sandbox_id,prompt_id,settled)
         select $1,unnest($2::text[]),false on conflict do nothing`,
        [id, references],
      );
    if (turns.size)
      await tx.query(
        `insert into public.runtime_idle_turns(sandbox_id,prompt_id,settled)
         select $1,prompt_id,settled from unnest($2::text[],$3::boolean[]) as t(prompt_id,settled)
         on conflict(sandbox_id,prompt_id) do update set settled=excluded.settled`,
        [id, [...turns.keys()], [...turns.values()]],
      );
    const latestPrompt = events.findLast((event) => event.kind === "prompt");
    const promptEnc = latestPrompt ? await encryptSecret(JSON.stringify(latestPrompt), key) : null;
    await tx.query(
      `update public.runtime_idle_evidence set sequence=$2,last_activity=greatest(last_activity,$3),
       unknown_turn=unknown_turn or $4,prompt_projection_sequence=$2,
       latest_prompt_enc=coalesce($5,latest_prompt_enc) where sandbox_id=$1`,
      [id, watermark, last, unknown, promptEnc],
    );
  }
  while (cursor < archiveSequence) {
    const rows = (
      await tx.query<{ sequence: string; event_enc: Uint8Array<ArrayBuffer> }>(
        `select sequence::text,event_enc from public.runtime_events
         where sandbox_id=$1 and sequence>$2 and sequence<=$3 order by runtime_events.sequence limit 1000`,
        [id, cursor, archiveSequence],
      )
    ).rows;
    if (!rows.length) throw Error("Incomplete idle archive.");
    for (const row of rows) {
      if (Number(row.sequence) !== cursor + 1) throw Error("Incomplete idle archive.");
      cursor++;
    }
    const events = await Promise.all(
      rows.map(async (row) => JSON.parse(await decryptSecret(row.event_enc, key)) as AgentEvent),
    );
    await apply(events, cursor);
  }
  if (cursor !== archiveSequence) throw Error("Idle evidence ahead of archive.");
  await apply(fresh, sequence);
}
