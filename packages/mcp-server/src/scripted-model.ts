import { createHash, timingSafeEqual } from "node:crypto";
import { decryptSecret } from "@armada/core/server";
import { z } from "zod";
import type { Route } from "./http.ts";
import { withRequestBodyCeiling } from "./request-body-ceiling.ts";

const path = "/internal/scripted-model/v1/responses";
const stagingOrigin = "https://armada-mcp-staging.up.railway.app";
const marker = "ARMADA_SCOPED_SMOKE_V1 ";
const namespace = "mcp__armada_orchestrator";
const smokeKey = z.string().regex(/^smoke-scoped-[a-f0-9-]{36}$/);
const scriptSchema = z.discriminatedUnion("lane", [
  z.object({
    lane: z.literal("parent"),
    launch: z.object({ idempotencyKey: smokeKey, selection: z.record(z.string(), z.unknown()) }),
    messageKey: smokeKey,
    stopKey: smokeKey,
    answer: z.string().regex(/^SCOPED_CHILD_[a-f0-9-]{36}$/),
    noAccess: z.string().regex(/^NO_ACCESS_[a-f0-9-]{36}$/),
  }),
  z.object({ lane: z.literal("child"), answer: z.string().regex(/^SCOPED_CHILD_[a-f0-9-]{36}$/) }),
]);

type Row = Record<string, unknown>;
const row = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown) => (Array.isArray(value) ? value.map(row) : []);
function decoded(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toolResult(value: unknown) {
  const output = decoded(value);
  const denied = rows(output).some((part) => part.type === "input_text" && part.text === "scoped_authority_denied");
  return { result: row(row(output).result), denied };
}

function hasAnswer(events: unknown, answer: string) {
  const messages = new Map<string, { text: string; partial: boolean }>();
  for (const event of rows(events)) {
    if (
      event.kind !== "message" ||
      event.responseKind === "tool_result" ||
      event.parentToolUseId ||
      event.retracted ||
      typeof event.text !== "string" ||
      typeof event.id !== "string" ||
      typeof event.partial !== "boolean"
    )
      continue;
    const id = typeof event.messageId === "string" ? event.messageId : event.id;
    const text = event.textMode === "delta" ? (messages.get(id)?.text ?? "") + event.text : event.text;
    messages.set(id, { text, partial: event.partial });
  }
  return [...messages.values()].some((message) => !message.partial && message.text === answer);
}

function nextItem(body: Row, id: string) {
  const reply = (text: string) => ({
    id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  });
  const input = rows(body.input);
  const userIndex = input.findLastIndex((item) => item.role === "user");
  const content = input[userIndex]?.content ?? body.input;
  const prompt = typeof content === "string" ? content : rows(content).find((part) => part.type === "input_text")?.text;
  const script = scriptSchema.safeParse(
    typeof prompt === "string" && prompt.startsWith(marker) ? decoded(prompt.slice(marker.length)) : undefined,
  );
  if (!script.success) return reply("No scripted smoke marker.");
  if (script.data.lane === "child") return reply(script.data.answer);

  const parent = script.data;
  const scopedTools = rows(body.tools)
    .filter((tool) => tool.type === "namespace" && tool.name === namespace)
    .flatMap((tool) => rows(tool.tools));
  const tools = new Set(scopedTools.filter((tool) => tool.type === "function").map((tool) => tool.name));
  if (!tools.has("launch")) return reply(parent.noAccess);
  const stopped = "Scripted smoke completed.";
  const failed = () => reply("Scripted smoke stopped before completing.");
  const outputs = new Map(
    input
      .slice(userIndex + 1)
      .filter((item) => item.type === "function_call_output")
      .map((item) => [item.call_id, item.output]),
  );
  const call = (action: string, args: Row, sequence: number) => {
    const callId = `call_${parent.launch.idempotencyKey}_${sequence}`;
    return {
      id: `fc_${parent.launch.idempotencyKey}_${sequence}`,
      type: "function_call",
      status: "completed",
      call_id: callId,
      namespace,
      name: action,
      arguments: JSON.stringify(args),
    };
  };
  const launch = call("launch", parent.launch, 0);
  if (!outputs.has(launch.call_id)) return launch;
  const launched = toolResult(outputs.get(launch.call_id));
  if (launched.denied) return reply(parent.noAccess);
  const child = z.uuid().safeParse(launched.result.sandboxId);
  if (launched.result.state !== "succeeded" || !child.success) return failed();
  const sandboxId = child.data;

  const childPrompt = marker + JSON.stringify({ lane: "child", answer: parent.answer });
  const message = call("message", { sandboxId, idempotencyKey: parent.messageKey, text: childPrompt }, 1);
  if (!tools.has(message.name)) return failed();
  if (!outputs.has(message.call_id)) return message;
  const messaged = toolResult(outputs.get(message.call_id)).result;
  if (messaged.state !== "succeeded" || messaged.sandboxId !== sandboxId) return failed();

  for (let index = 0; index < 20; index++) {
    const read = call("read", { sandboxId }, index + 2);
    if (!tools.has(read.name)) return failed();
    if (!outputs.has(read.call_id)) return read;
    const result = toolResult(outputs.get(read.call_id)).result;
    if (result.id !== sandboxId || !Array.isArray(result.events)) return failed();
    if (hasAnswer(result.events, parent.answer)) {
      const stop = call("stop", { sandboxId, idempotencyKey: parent.stopKey }, index + 3);
      if (!tools.has(stop.name)) return failed();
      if (!outputs.has(stop.call_id)) return stop;
      const receipt = toolResult(outputs.get(stop.call_id)).result;
      return receipt.state === "succeeded" && receipt.sandboxId === sandboxId ? reply(stopped) : failed();
    }
  }
  return failed();
}

function responses(body: Row) {
  const id = crypto.randomUUID();
  const item = nextItem(body, `msg_${id}`);
  const response = {
    id: `resp_${id}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: body.model,
    status: "completed",
    output: [item],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
  const headers = { "cache-control": "no-store" };
  if (body.stream !== true) return Response.json(response, { headers });

  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  const stream = events
    .map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
    .join("");
  return new Response(stream, { headers: { ...headers, "content-type": "text/event-stream" } });
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export async function scriptedModelRoute(
  env: Record<string, string | undefined>,
  config: { publicUrl: string; encryptionKey: string },
) {
  if (env.ARMADA_SCRIPTED_MODEL !== "1") return;
  if (env.RAILWAY_ENVIRONMENT_NAME !== "staging" || config.publicUrl !== stagingOrigin)
    throw new Error("ARMADA_SCRIPTED_MODEL=1 requires the Railway staging environment and staging public origin.");

  let expected: Buffer;
  try {
    const sealed = env.ARMADA_SCRIPTED_MODEL_BEARER_ENC ?? "";
    const token = await decryptSecret(Uint8Array.from(Buffer.from(sealed, "base64")), config.encryptionKey);
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error();
    expected = digest(`Bearer ${token}`);
  } catch {
    throw new Error("Set ARMADA_SCRIPTED_MODEL_BEARER_ENC to a sealed staging bearer.");
  }

  const route: Route = async (request) => {
    if (request.method !== "POST" || new URL(request.url).pathname !== path) return null;
    if (!timingSafeEqual(expected, digest(request.headers.get("authorization") ?? "")))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    return withRequestBodyCeiling(request, 1024 * 1024, async (bounded) => {
      const body = row(await bounded.json().catch(() => null));
      if (typeof body.model !== "string" || (!Array.isArray(body.input) && typeof body.input !== "string"))
        return Response.json({ error: "invalid_request" }, { status: 400 });
      return responses(body);
    });
  };
  return route;
}
