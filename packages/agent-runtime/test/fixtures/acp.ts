import { createInterface } from "node:readline";

let active: number | undefined;
const send = (value: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const m = JSON.parse(line);
  const reply = (result: object) => send({ id: m.id, result });
  switch (m.method) {
    case "initialize":
      reply({ protocolVersion: process.env.BAD_ACP ? 2 : 1, agentCapabilities: { loadSession: true } });
      break;
    case "session/new":
      reply({ sessionId: "session-1" });
      break;
    case "session/load":
      send({
        method: "session/update",
        params: {
          sessionId: m.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "history" } },
        },
      });
      reply({});
      break;
    case "session/set_model":
      reply({});
      break;
    case "session/prompt": {
      if (m.params.sessionId !== "session-1") throw Error("wrong_session");
      const text = m.params.prompt[0].text;
      send({
        method: "session/update",
        params: {
          sessionId: "unrelated",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "unrelated" } },
        },
      });
      for (const fragment of text === "DOCKER_OK" ? ["D", "OCK", "ER", "_OK"] : [text])
        send({
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: fragment } },
          },
        });
      if (text === "hold") {
        active = m.id;
        break;
      }
      reply({
        stopReason: "end_turn",
        ...(text === "unknown"
          ? {}
          : {
              usage: { inputTokens: 3, outputTokens: 2, cachedReadTokens: 1, cachedWriteTokens: 0, thoughtTokens: 0 },
            }),
      });
      break;
    }
    case "session/cancel":
      if (active !== undefined) {
        send({
          id: active,
          result: {
            stopReason: "cancelled",
            usage: { inputTokens: 4, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0 },
          },
        });
        active = undefined;
      }
      break;
    default:
      send({ id: m.id, error: { code: -32601, message: "unknown" } });
  }
}
