import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admitRequest,
  authEventSchema,
  coordinatorModelSchema,
  projectRulesSchema,
  serverMessageSchema,
  PROTOCOL_VERSION as version,
} from "../dist/index.js";

test("the shared auth flow supports model OAuth, manual/secret/select prompts and terminal providers", () => {
  for (const event of [
    { type: "auth_url", url: "https://example.test/login" },
    { type: "device_code", userCode: "ORCHARD", verificationUri: "https://example.test/device" },
    { type: "progress", message: "Connecting" },
    { type: "info", message: "Paste the code", links: [{ url: "https://example.test/help" }] },
    { type: "terminal", output: "Continue in your terminal" },
  ]) {
    assert.equal(serverMessageSchema.safeParse({ type: "auth.event", version, flow: "login-1", event }).success, true);
  }
  for (const promptType of ["text", "secret", "select", "manual_code"]) {
    assert.equal(
      serverMessageSchema.safeParse({
        type: "auth.prompt",
        version,
        flow: "login-1",
        id: "prompt-1",
        promptType,
        message: "Continue",
        ...(promptType === "select" ? { options: [{ id: "one", label: "One" }] } : {}),
      }).success,
      true,
    );
  }
  for (const message of [
    { type: "models.login", provider: "openai-codex", authType: "oauth", id: "login-1" },
    { type: "auth.answer", flow: "login-1", id: "prompt-1", value: "answer" },
    { type: "auth.cancel", flow: "login-1", id: "cancel-1" },
  ])
    assert.equal(admitRequest({ ...message, version }).ok, true);
  assert.equal(admitRequest({ type: "auth.answer", version, id: "prompt-1", value: "answer" }).ok, false);
  assert.equal(authEventSchema.safeParse({ type: "credential", access: "forbidden" }).success, false);
  for (const url of ["javascript:alert(1)", "file:///tmp/sign-in", "data:text/html,sign-in", "custom:login"]) {
    assert.equal(authEventSchema.safeParse({ type: "auth_url", url }).success, false);
    assert.equal(
      authEventSchema.safeParse({ type: "device_code", userCode: "ORCHARD", verificationUri: url }).success,
      false,
    );
    assert.equal(authEventSchema.safeParse({ type: "info", message: "Sign in", links: [{ url }] }).success, false);
  }
});

test("project rules accept a pi model reference and retain custom plugin model configuration", () => {
  for (const coordinatorModel of [
    { provider: "openai-codex", model: "gpt-5.1-codex" },
    { kind: "openai-compatible", config: { baseURL: "http://localhost/v1", model: "custom" } },
  ]) {
    assert.deepEqual(coordinatorModelSchema.parse(coordinatorModel), coordinatorModel);
    assert.deepEqual(projectRulesSchema.parse({ coordinatorModel }).coordinatorModel, coordinatorModel);
  }
  assert.equal(coordinatorModelSchema.safeParse({ provider: "openai", model: "" }).success, false);
});
