import { expect, test } from "bun:test";
import { encryptSecret } from "@armada/core/server";
import { scriptedModelRoute } from "./scripted-model.ts";

const publicUrl = "https://armada-mcp-staging.up.railway.app";
const env = { RAILWAY_ENVIRONMENT_NAME: "staging", ARMADA_SCRIPTED_MODEL: "1" };
const encryptionKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

async function client() {
  const key = encryptionKey();
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const sealed = await encryptSecret(token, key);
  const route = await scriptedModelRoute(
    { ...env, ARMADA_SCRIPTED_MODEL_BEARER_ENC: Buffer.from(sealed).toString("base64") },
    { publicUrl, encryptionKey: key },
  );
  if (!route) throw new Error("Expected the staging route");
  return (body: object, authorized = true) =>
    route(
      new Request(`${publicUrl}/internal/scripted-model/v1/responses`, {
        method: "POST",
        headers: authorized ? { authorization: `Bearer ${token}` } : {},
        body: JSON.stringify({ model: "scripted", ...body }),
      }),
    );
}

test("refuses enabled startup in production even with the staging origin", async () => {
  await expect(
    scriptedModelRoute(
      { ...env, RAILWAY_ENVIRONMENT_NAME: "production" },
      { publicUrl, encryptionKey: encryptionKey() },
    ),
  ).rejects.toThrow("requires the Railway staging environment and staging public origin");
});

test("requires the bearer before accepting a Responses request", async () => {
  const send = await client();
  expect((await send({ input: "hello" }, false))?.status).toBe(401);
});

test("returns plain text for an unrecognized marker", async () => {
  const send = await client();
  expect(await (await send({ input: "hello" }))?.json()).toMatchObject({
    output: [{ type: "message", content: [{ type: "output_text", text: "No scripted smoke marker." }] }],
  });
});

const key = () => `smoke-scoped-${crypto.randomUUID()}`;
const namespace = "mcp__armada_orchestrator";
const tools = ["launch", "message", "read", "stop"].map((name) => ({
  type: "namespace",
  name: namespace,
  tools: [{ type: "function", name }],
}));

function parentTurn() {
  const launch = { idempotencyKey: key(), selection: { harness: "codex", goldenId: crypto.randomUUID() } };
  const messageKey = key();
  const stopKey = key();
  const answer = `SCOPED_CHILD_${crypto.randomUUID()}`;
  const noAccess = `NO_ACCESS_${crypto.randomUUID()}`;
  const text = `ARMADA_SCOPED_SMOKE_V1 ${JSON.stringify({ lane: "parent", launch, messageKey, stopKey, answer, noAccess })}`;
  const input: object[] = [{ role: "user", content: [{ type: "input_text", text }] }];
  return { input, launch, messageKey, stopKey, answer, noAccess };
}

test("scripts scoped launch, message, read and stop using the actual child receipt and answer", async () => {
  const send = await client();
  const { input, launch, messageKey, stopKey, answer } = parentTurn();
  const sandboxId = crypto.randomUUID();
  async function next() {
    const response = await send({ input, tools, stream: true });
    expect(response?.headers.get("content-type")).toContain("text/event-stream");
    const event = (await response?.text())
      ?.split("\n")
      .find((line) => line.startsWith('data: {"type":"response.completed"'));
    if (!event) throw new Error("Missing Responses completion event");
    return JSON.parse(event.slice(6)).response.output[0];
  }
  function receipt(call: { call_id: string }, result: object) {
    input.push(call, {
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify({ result }),
    });
  }

  const launchCall = await next();
  expect(launchCall).toMatchObject({ type: "function_call", namespace, name: "launch" });
  expect(JSON.parse(launchCall.arguments)).toEqual(launch);
  receipt(launchCall, { state: "succeeded", sandboxId });
  const message = await next();
  const messageArgs = JSON.parse(message.arguments);
  expect(message.name).toBe("message");
  expect(messageArgs).toMatchObject({ sandboxId, idempotencyKey: messageKey });
  const child = await (await send({ input: messageArgs.text }))?.json();
  expect(child).toMatchObject({ output: [{ content: [{ text: answer }] }] });
  receipt(message, { state: "succeeded", sandboxId });

  const firstRead = await next();
  expect(firstRead.name).toBe("read");
  expect(JSON.parse(firstRead.arguments)).toEqual({ sandboxId });
  receipt(firstRead, { id: sandboxId, events: [] });
  const secondRead = await next();
  expect(secondRead.name).toBe("read");
  receipt(secondRead, {
    id: sandboxId,
    events: [{ id: "answer", kind: "message", text: answer, partial: false }],
  });
  const stop = await next();
  expect(stop.name).toBe("stop");
  expect(JSON.parse(stop.arguments)).toEqual({ sandboxId, idempotencyKey: stopKey });
  receipt(stop, { state: "succeeded", sandboxId });
  expect(await next()).toMatchObject({ type: "message", content: [{ text: "Scripted smoke completed." }] });
});

test("returns the no-access answer when the gateway denies scoped launch", async () => {
  const send = await client();
  const { input, noAccess } = parentTurn();
  const response = (await (await send({ input, tools }))?.json()) as { output: [{ call_id: string }] };
  const call = response.output[0];
  input.push(call, {
    type: "function_call_output",
    call_id: call.call_id,
    output: [{ type: "input_text", text: "scoped_authority_denied" }],
  });
  expect(await (await send({ input, tools }))?.json()).toMatchObject({
    output: [{ type: "message", content: [{ text: noAccess }] }],
  });
});
