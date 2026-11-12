/** Coordinator-only synthetic WSS protocol check. No native harness/provider/model execution. */
import { createRuntimeCommands } from "../packages/mcp-server/src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../packages/mcp-server/src/runtime-enrolment.ts";
import { bunSql } from "../packages/mcp-server/src/sql.ts";

async function main() {
  if (process.env.ARMADA_RUNTIME_SOCKET_SMOKE !== "use_disposable_staging_sandbox")
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
  let socket: WebSocket | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const key = required("ARMADA_STAGING_ENCRYPTION_KEY"),
      ownerId = required("ARMADA_STAGING_OWNER_ID"),
      sandboxId = required("ARMADA_STAGING_SANDBOX_ID");
    const authority = createRuntimeEnrolments(sql, key),
      commands = createRuntimeCommands(authority, key);
    const ticket = await authority.issue({ sandboxId, ownerId, configuration: { marker: "synthetic-socket-smoke" } });
    const exchange = await fetch(new URL("/api/runtime/enrol", origin), {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${ticket.enrolmentToken}` },
    });
    if (exchange.status !== 200) throw Error("staging_enrol_failed");
    const active = (await exchange.json()) as { runtimeToken: string; epoch: string };
    const requestId = crypto.randomUUID();
    await commands.enqueue(ownerId, { version: 1, sandboxId, requestId, op: "health" });
    const url = new URL("/api/runtime/channel", origin);
    url.protocol = "wss:";
    const completed = Promise.withResolvers<void>();
    let sawCommand = false,
      sawPong = false,
      replaced = false,
      replacementDone = false,
      revokedClose = false;
    socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
    });
    const currentSocket = socket;
    socket.addEventListener("open", () => currentSocket.send(JSON.stringify({ type: "ready", epoch: active.epoch })));
    socket.addEventListener("message", (message) => {
      void (async () => {
        const frame = JSON.parse(String(message.data)) as {
          type: string;
          epoch: string;
          request?: { requestId: string; sandboxId: string; op: string };
        };
        if (frame.epoch !== active.epoch) throw Error("staging_wrong_epoch");
        if (frame.type === "command") {
          if (
            sawCommand ||
            frame.request?.requestId !== requestId ||
            frame.request.sandboxId !== sandboxId ||
            frame.request.op !== "health"
          )
            throw Error("staging_command_failed");
          sawCommand = true;
          // Synthetic reply tests the deployed mailbox, not execution of a health RPC.
          const response = await fetch(new URL("/api/runtime/results", origin), {
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
              epoch: active.epoch,
              requestId,
              status: 200,
              body: { requestId, result: { marker: "synthetic-socket-reply" } },
            }),
          });
          if (response.status !== 200) throw Error("staging_result_failed");
          const ack = (await response.json()) as { epoch: string; requestId: string };
          if (
            ack.epoch !== active.epoch ||
            ack.requestId !== requestId ||
            (await commands.result(ownerId, sandboxId, requestId)).state !== "finished"
          )
            throw Error("staging_ack_failed");
          currentSocket.send(JSON.stringify({ type: "ping", epoch: active.epoch }));
        } else if (frame.type === "pong") {
          if (!sawCommand || sawPong) throw Error("staging_pong_failed");
          sawPong = true;
          replaced = true;
          await authority.issue({ sandboxId, ownerId, configuration: {} });
          replacementDone = true;
          if (revokedClose) completed.resolve();
          else if (currentSocket.readyState === WebSocket.OPEN)
            currentSocket.send(JSON.stringify({ type: "ping", epoch: active.epoch }));
        } else throw Error("staging_frame_failed");
      })().catch(() => completed.reject(Error("staging_socket_protocol_failed")));
    });
    socket.addEventListener("error", () => completed.reject(Error("staging_socket_failed")));
    socket.addEventListener("close", (event) => {
      if (replaced && sawCommand && sawPong && event.code === 4401) {
        revokedClose = true;
        if (replacementDone) completed.resolve();
      } else completed.reject(Error("staging_revocation_failed"));
    });
    deadline = setTimeout(() => completed.reject(Error("staging_socket_timeout")), 45000);
    await completed.promise;
    console.log(
      "Runtime socket staging smoke passed: authenticated WSS command, HTTP result ACK, pong and epoch rejection",
    );
  } finally {
    if (deadline) clearTimeout(deadline);
    socket?.terminate();
    await sql.close();
  }
}
void main().catch(() => {
  console.error("runtime_socket_staging_smoke_failed");
  process.exitCode = 1;
});
