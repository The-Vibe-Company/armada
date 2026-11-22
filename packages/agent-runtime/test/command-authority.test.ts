import { expect, setSystemTime, test } from "bun:test";
import { AUTH_HEADER, Journal, Runner } from "../src/index.ts";

const epoch = "epoch-1";
const initialExpiry = 2_000_000_000_000;
const extendedExpiry = initialExpiry + 60_000;
const extension = { op: "extendCommandAuthority", epoch, expiresAt: extendedExpiry };
const configuration = {
  version: 1,
  revision: "1",
  generation: epoch,
  expiresAt: extendedExpiry,
};

function fixture(enrolled = true) {
  const journal = new Journal(":memory:", (text) => text);
  const grant = { token: crypto.randomUUID(), sandboxId: "sandbox", generation: epoch, expiresAt: initialExpiry };
  const configureGitHub = async () => {};
  const runner = new Runner(journal, grant, {}, undefined, undefined, undefined, { enrolled, configureGitHub });
  const body = (command: Record<string, unknown>) =>
    JSON.stringify({ version: 1, sandboxId: "sandbox", requestId: crypto.randomUUID(), ...command });
  const send = (body: string | ReadableStream<Uint8Array>, token: string = grant.token) =>
    runner.handle(
      new Request("http://runtime/v1", {
        method: "POST",
        headers: { [AUTH_HEADER]: token },
        body,
      }),
    );
  const call = (command: Record<string, unknown>, token?: string) => send(body(command), token);
  return { journal, call, body, send };
}

test("live health advertises extension and the same epoch accepts GitHub configuration beyond bootstrap", async () => {
  const { journal, call } = fixture();
  setSystemTime(new Date(initialExpiry - 1));
  try {
    expect(await (await call({ op: "health" })).json()).toMatchObject({
      result: { commandAuthorityExtension: 1, generation: epoch },
    });
    expect((await call({ op: "configureGitHub", configuration })).status).toBe(409);
    const requestId = "extend-1";
    const result = { version: 1, requestId, result: { epoch, expiresAt: extendedExpiry } };
    expect(await (await call({ ...extension, requestId })).json()).toEqual(result);
    expect(
      await (await call({ ...extension, requestId: "extend-earlier", expiresAt: extendedExpiry - 1 })).json(),
    ).toMatchObject({ result: { expiresAt: extendedExpiry } });
    setSystemTime(new Date(initialExpiry));
    expect(await (await call({ ...extension, requestId })).json()).toEqual(result);
    expect((await call({ op: "configureGitHub", configuration })).status).toBe(200);
    setSystemTime(new Date(extendedExpiry));
    expect((await call({ op: "health" })).status).toBe(401);
  } finally {
    setSystemTime();
    journal.close();
  }
});

test.each([
  { name: "wrong token", payload: {}, token: "wrong", status: 401 },
  { name: "wrong sandbox", payload: { sandboxId: "wrong" }, status: 409 },
  { name: "stale epoch", payload: { epoch: "epoch-0" }, status: 409 },
  { name: "invalid deadline", payload: { expiresAt: "later" }, status: 409 },
])("extension refuses $name without raising the GitHub bound", async ({ payload, token, status }) => {
  const { journal, call } = fixture();
  try {
    expect((await call({ ...extension, ...payload }, token)).status).toBe(status);
    expect((await call({ op: "configureGitHub", configuration })).status).toBe(409);
  } finally {
    journal.close();
  }
});

test("extension cannot revive an expired grant", async () => {
  const { journal, call } = fixture();
  setSystemTime(new Date(initialExpiry));
  try {
    expect((await call(extension)).status).toBe(401);
    expect((await call({ op: "health" })).status).toBe(401);
  } finally {
    setSystemTime();
    journal.close();
  }
});

test("extension refuses a grant that expires while the request body is read", async () => {
  const { journal, body, send } = fixture();
  setSystemTime(new Date(initialExpiry - 1));
  try {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        setSystemTime(new Date(initialExpiry));
        controller.enqueue(new TextEncoder().encode(body(extension)));
        controller.close();
      },
    });
    expect((await send(stream)).status).toBe(401);
  } finally {
    setSystemTime();
    journal.close();
  }
});

test("checkpoint fences extensions and replays on the current epoch", async () => {
  const { journal, call } = fixture();
  try {
    const command = { ...extension, requestId: "extend-before-checkpoint" };
    expect((await call(command)).status).toBe(200);
    expect((await call({ op: "checkpoint" })).status).toBe(200);
    const response = await call(command);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "checkpoint_in_progress" });
  } finally {
    journal.close();
  }
});

test("unenrolled runtimes omit the health capability and refuse extension", async () => {
  const { journal, call } = fixture(false);
  try {
    const health = await (await call({ op: "health" })).json();
    expect(health).toMatchObject({ result: { generation: epoch, ready: true } });
    expect(health).not.toHaveProperty("result.commandAuthorityExtension");
    expect((await call(extension)).status).toBe(409);
  } finally {
    journal.close();
  }
});
