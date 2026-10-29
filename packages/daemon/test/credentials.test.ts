import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { admitRequest, PROTOCOL_VERSION, serverMessageSchema } from "@armada/protocol";
import { dispatchCredentials } from "../src/credentials.ts";
import { Keychain } from "../src/keychain.ts";
import { FakeKeychain } from "./support/keychain.ts";

test("admitted credential writes return status only; backend failures and malformed keys never echo credentials", async (t) => {
  const key = randomBytes(24).toString("hex");
  const output: unknown[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => output.push(args));
  t.mock.method(console, "error", (...args: unknown[]) => output.push(args));
  t.mock.method(console, "warn", (...args: unknown[]) => output.push(args));
  const chain = new Keychain(new FakeKeychain());
  const request = { type: "credentials.set", version: PROTOCOL_VERSION, id: "save", provider: "openai", key };
  const admitted = admitRequest(request);
  assert.equal(admitted.ok, true);
  if (!admitted.ok || admitted.request.type !== "credentials.set") throw new Error("Admission failed");
  const response = await dispatchCredentials(admitted.request, chain);
  assert.equal(serverMessageSchema.safeParse(response).success, true);
  const legacyConfig = { baseURL: "https://api.openai.com/v1", model: "gpt-4.1-mini" };
  assert.deepEqual(response, {
    type: "credentials.result",
    version: PROTOCOL_VERSION,
    id: "save",
    provider: "openai-compatible",
    config: legacyConfig,
    storage: "os-keychain",
  });
  assert.deepEqual(await chain.coordinator(), { provider: "openai-compatible", key, config: legacyConfig });
  const oldApp = await dispatchCredentials({ ...admitted.request, version: { major: 1, minor: 1 } }, chain, [
    { kind: "openai-compatible", description: "Compatible", config: {} },
  ]);
  assert.equal(oldApp.type === "credentials.result" && oldApp.provider, "openai");
  const damaged = new Keychain(new FakeKeychain());
  await damaged.write("coordinator", "coordinator", "{");
  await assert.rejects(damaged.coordinator(), /Saved model credential is invalid/);
  const recovered = await dispatchCredentials(admitted.request, damaged);
  assert.equal(recovered.type, "credentials.result");
  assert.equal((await damaged.coordinator())?.key === key, true);
  const failing = new Keychain({
    storage: "os-keychain",
    read: async () => {
      throw new Error(key);
    },
    write: async () => {
      throw new Error(key);
    },
  });
  const failure = await dispatchCredentials(admitted.request, failing);
  assert.equal(failure.type, "error");
  const readFailure = await dispatchCredentials(
    { type: "credentials.status", version: PROTOCOL_VERSION, id: "locked-status" },
    failing,
  );
  assert.equal(readFailure.type, "error");
  assert.equal(admitRequest({ ...request, key: `${key}\n` }).ok, false);
  assert.equal(admitRequest({ ...request, provider: "custom-model" }).ok, true);
  const unknown = await dispatchCredentials({ ...admitted.request, provider: "not-loaded" }, chain, [
    { kind: "openai-compatible", description: "Compatible", config: {} },
  ]);
  assert.equal(unknown.type, "error");
  const custom = await dispatchCredentials(
    { ...admitted.request, provider: "openai-compatible", config: { baseURL: "http://localhost/v1", model: "local" } },
    chain,
    [{ kind: "openai-compatible", description: "Compatible", config: {} }],
  );
  assert.equal(custom.type, "credentials.result");
  if (custom.type === "credentials.result") {
    assert.equal(custom.models?.[0]?.kind, "openai-compatible");
    assert.equal(custom.config?.model, "local");
  }
  assert.equal(JSON.stringify([response, failure, readFailure, output]).includes(key), false);
  assert.deepEqual(output, []);
});
