import { decryptSecret, type Sql } from "@armada/core/server";

/** Runs before accepting traffic/workers. Never infer an override from the launch default.
 * Failed decryption aborts startup rather than admitting work under an invented identity.
 */
export async function repairHistoricalTurnModels(sql: Sql, key: string): Promise<void> {
  if (!sql.transaction) throw new Error("Model identity upgrade requires transactions.");
  await sql.transaction(async (tx) => {
    // Serialize replicas and writers while reconstructing the paired reservation identities.
    await tx.query(
      "lock table public.account_turn_queue, public.account_agent_reservations in share row exclusive mode",
    );
    const rows = await tx.query<{
      sandbox_id: string;
      request_id: string;
      input_enc: Uint8Array<ArrayBuffer>;
      launch_model: string | null;
    }>(`select q.sandbox_id,q.request_id,q.input_enc,s.model as launch_model
      from public.account_turn_queue q join public.sandboxes s on s.id=q.sandbox_id
      where q.model is null`);
    for (const row of rows.rows) {
      let input: { model?: unknown };
      try {
        input = JSON.parse(await decryptSecret(row.input_enc, key));
        if (!input || typeof input !== "object") throw new Error();
      } catch {
        throw new Error("Historical turn model reconstruction failed.");
      }
      if (input.model != null && (typeof input.model !== "string" || !input.model.length))
        throw new Error("Invalid historical turn model.");
      await tx.query("update public.account_turn_queue set model=$3 where sandbox_id=$1 and request_id=$2", [
        row.sandbox_id,
        row.request_id,
        input.model ?? row.launch_model,
      ]);
    }
    await tx.query(`update public.account_agent_reservations r set model=case
      when exists(select 1 from public.account_turn_queue q where q.sandbox_id=r.sandbox_id and q.state in ('admitted','dispatching'))
      then (select q.model from public.account_turn_queue q where q.sandbox_id=r.sandbox_id and q.state in ('admitted','dispatching') order by q.sequence desc limit 1)
      else (select s.model from public.sandboxes s where s.id=r.sandbox_id) end
      where r.model is null`);
  });
}
