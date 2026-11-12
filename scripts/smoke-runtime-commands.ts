/** Coordinator-only synthetic protocol smoke. No harness, provider or model is executed. */
import { createRuntimeCommands } from "../packages/mcp-server/src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../packages/mcp-server/src/runtime-enrolment.ts";
import { bunSql } from "../packages/mcp-server/src/sql.ts";

async function main() {
  if (process.env.ARMADA_RUNTIME_COMMAND_SMOKE !== "use_disposable_staging_sandbox")
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
    const authority = createRuntimeEnrolments(sql, key),
      commands = createRuntimeCommands(authority, key);
    async function post(path: string, token: string, epoch?: string, body?: unknown) {
      return fetch(new URL(`/api/runtime/${path}`, origin), {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(25000),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(epoch ? { "x-armada-runtime-epoch": epoch } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    const ticket = await authority.issue({ ownerId, sandboxId, configuration: { marker: "command-mailbox-smoke" } });
    const exchanged = await post("enrol", ticket.enrolmentToken);
    if (exchanged.status !== 200) throw Error("staging_exchange_failed");
    const active = (await exchanged.json()) as { runtimeToken: string; epoch: string };
    const requestId = crypto.randomUUID();
    await commands.enqueue(ownerId, { version: 1, sandboxId, requestId, op: "health" });
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await post("poll", active.runtimeToken, active.epoch, { epoch: active.epoch });
      if (response.status !== 200 || response.headers.get("cache-control") !== "no-store")
        throw Error("staging_poll_failed");
      const polled = (await response.json()) as {
        epoch: string;
        command: { requestId: string; sandboxId: string; op: string };
      };
      if (
        polled.epoch !== active.epoch ||
        polled.command.requestId !== requestId ||
        polled.command.sandboxId !== sandboxId ||
        polled.command.op !== "health"
      )
        throw Error("staging_redelivery_failed");
    }
    // This is a synthetic runtime reply, explicitly NOT evidence of executing a health RPC.
    const reply = {
      epoch: active.epoch,
      requestId,
      status: 200,
      body: { requestId, result: { marker: "synthetic-mailbox-reply" } },
    };
    for (let repeat = 0; repeat < 2; repeat++) {
      const ack = await post("results", active.runtimeToken, active.epoch, reply);
      if (ack.status !== 200) throw Error("staging_result_failed");
      const received = (await ack.json()) as { epoch: string; requestId: string };
      if (received.epoch !== active.epoch || received.requestId !== requestId) throw Error("staging_ack_failed");
    }
    const result = await commands.result(ownerId, sandboxId, requestId);
    if (result.state !== "finished" || JSON.stringify(result.reply) !== JSON.stringify(reply))
      throw Error("staging_readback_failed");
    await authority.issue({ ownerId, sandboxId, configuration: {} }); // Revoke the synthetic client.
    if ((await post("results", active.runtimeToken, active.epoch, reply)).status !== 401)
      throw Error("staging_epoch_fence_failed");
    console.log("Runtime command staging smoke passed: durable redelivery, ACK replay and epoch fence");
  } finally {
    await sql.close();
  }
}
void main().catch(() => {
  console.error("runtime_command_staging_smoke_failed");
  process.exitCode = 1;
});
