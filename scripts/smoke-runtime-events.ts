/** Coordinator-only synthetic event protocol check. Never calls a harness/provider/model. */

import { decryptSecret } from "../packages/core/src/crypto.ts";
import type { AgentEvent } from "../packages/core/src/provider.ts";
import { createRuntimeEnrolments } from "../packages/mcp-server/src/runtime-enrolment.ts";
import { bunSql } from "../packages/mcp-server/src/sql.ts";

async function main() {
  if (process.env.ARMADA_RUNTIME_EVENT_SMOKE !== "use_disposable_staging_sandbox")
    throw Error("staging_smoke_not_enabled");
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw Error("staging_smoke_configuration_missing");
    return value;
  };
  const origin = new URL(required("ARMADA_STAGING_URL"));
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error("staging_smoke_invalid_origin");
  const sql = bunSql(required("ARMADA_STAGING_DATABASE_URL"));
  try {
    const key = required("ARMADA_STAGING_ENCRYPTION_KEY"),
      sandboxId = required("ARMADA_STAGING_SANDBOX_ID"),
      ownerId = required("ARMADA_STAGING_OWNER_ID");
    const previous = await sql.query("select sequence from runtime_events where sandbox_id=$1 limit 1", [sandboxId]);
    if (previous.rows.length) throw Error("staging_smoke_requires_empty_archive");
    const authority = createRuntimeEnrolments(sql, key);
    const ticket = await authority.issue({ sandboxId, ownerId, configuration: { marker: "synthetic-event-smoke" } });
    const exchanged = await fetch(new URL("/api/runtime/enrol", origin), {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: { authorization: `Bearer ${ticket.enrolmentToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (exchanged.status !== 200) throw Error("staging_exchange_failed");
    const active = (await exchanged.json()) as { runtimeToken: string; epoch: string };
    const event: AgentEvent = {
      id: crypto.randomUUID(),
      at: Date.now(),
      kind: "other",
      promptId: crypto.randomUUID(),
      type: "armada/turnUsage",
      data: {
        model: "synthetic-staging-model",
        inputTokens: 17,
        outputTokens: 5,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    };
    const payload = { sandboxId, generation: active.epoch, events: [{ sequence: 1, event }] };
    const publish = () =>
      fetch(new URL("/api/runtime/events", origin), {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        headers: {
          authorization: `Bearer ${active.runtimeToken}`,
          "x-armada-runtime-epoch": active.epoch,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await publish();
      if (
        response.status !== 200 ||
        response.headers.get("cache-control") !== "no-store" ||
        ((await response.json()) as { acknowledgedSequence: number }).acknowledgedSequence !== 1
      )
        throw Error("staging_ack_failed");
    }
    const stored = await sql.query<{ event_enc: Uint8Array<ArrayBuffer> }>(
      "select event_enc from runtime_events where sandbox_id=$1",
      [sandboxId],
    );
    if (stored.rows.length !== 1 || !stored.rows[0]) throw Error("staging_replay_failed");
    const decoded = JSON.parse(await decryptSecret(stored.rows[0].event_enc, key)) as AgentEvent;
    if (decoded.id !== event.id || decoded.promptId !== event.promptId) throw Error("staging_archive_failed");
    const projection = (
      await sql.query<{ usage_turns: { turns: { promptId: string; inputTokens: number; outputTokens: number }[] } }>(
        "select usage_turns from sandboxes where id=$1",
        [sandboxId],
      )
    ).rows[0];
    if (
      !projection?.usage_turns.turns.some(
        (turn) => turn.promptId === event.promptId && turn.inputTokens === 17 && turn.outputTokens === 5,
      )
    )
      throw Error("staging_projection_failed");
    await authority.issue({ sandboxId, ownerId, configuration: {} }); // Revoke the synthetic producer.
    if ((await publish()).status !== 401) throw Error("staging_epoch_fence_failed");
    console.log("Runtime event staging smoke passed: encrypted archive, replay ACK, usage projection and epoch fence");
  } finally {
    await sql.close();
  }
}
void main().catch(() => {
  console.error("runtime_event_staging_smoke_failed");
  process.exitCode = 1;
});
