/** Coordinator-only staging check: republishes existing state without rotating or printing it. */

import type { GoldenActor } from "../packages/core/src/golden.ts";
import { createModelAuthOwnership } from "../packages/mcp-server/src/model-auth.ts";
import { createRuntimeEnrolments } from "../packages/mcp-server/src/runtime-enrolment.ts";
import { bunSql } from "../packages/mcp-server/src/sql.ts";

async function main() {
  if (process.env.ARMADA_RUNTIME_NATIVE_AUTH_SMOKE !== "use_disposable_staging_subscription")
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
      ownerId = required("ARMADA_STAGING_OWNER_ID"),
      sandboxId = required("ARMADA_STAGING_SANDBOX_ID");
    const binding = (
      await sql.query<{ org_id: string; credential_id: string; credential_version: number }>(
        `select s.org_id,s.credential_id,s.credential_version from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
       join public.credentials c on c.id=s.credential_id where s.id=$1 and s.owner_id=$2 and s.provider='boat' and s.harness='codex'
       and s.status='ready' and s.stop_requested_at is null and s.deleted_at is null and cardinality(s.conversation_ids)=0
       and s.task_prompt_id is null and c.kind='codex_auth' and s.credential_version is not null`,
        [sandboxId, ownerId],
      )
    ).rows[0];
    if (!binding) throw Error("staging_smoke_requires_idle_disposable_subscription_holder");
    const actor: GoldenActor = { userId: ownerId, orgId: binding.org_id, role: "member" };
    const current = await createModelAuthOwnership(sql, key).bootstrap(
      actor,
      binding.credential_id,
      binding.credential_version,
      sandboxId,
    );
    if (!current.authJson) throw Error("staging_smoke_state_unavailable");
    const authority = createRuntimeEnrolments(sql, key),
      ticket = await authority.issue({ ownerId, sandboxId, configuration: {} });
    const exchange = await fetch(new URL("/api/runtime/enrol", origin), {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: { authorization: `Bearer ${ticket.enrolmentToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (exchange.status !== 200) throw Error("staging_smoke_enrol_failed");
    const active = (await exchange.json()) as { runtimeToken: string; epoch: string };
    const publish = () =>
      fetch(new URL("/api/runtime/events", origin), {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: `Bearer ${active.runtimeToken}`,
          "x-armada-runtime-epoch": active.epoch,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sandboxId,
          generation: active.epoch,
          events: [],
          nativeAuth: { authJson: current.authJson, expectedRevision: current.revision },
        }),
      });
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await publish();
      if (response.status !== 200 || response.headers.get("cache-control") !== "no-store")
        throw Error("staging_smoke_publication_failed");
      const receipt = (await response.json()) as { authRevision: number; committed: boolean };
      if (receipt.authRevision !== current.revision || receipt.committed !== true)
        throw Error("staging_smoke_receipt_failed");
    }
    await authority.issue({ ownerId, sandboxId, configuration: {} });
    if ((await publish()).status !== 401) throw Error("staging_smoke_epoch_fence_failed");
    console.log("Runtime native-auth staging smoke passed: unchanged sealed state, replay receipt and epoch rejection");
  } finally {
    await sql.close();
  }
}
void main().catch(() => {
  console.error("runtime_native_auth_staging_smoke_failed");
  process.exitCode = 1;
});
