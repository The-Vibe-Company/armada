import { expect, test } from "bun:test";
import { type CredentialReader, encryptSecret } from "@armada/core/server";
import { preflightOttoEngine } from "./engine-preflight.ts";

test("preflight checks the exact account without exposing its material or choosing a fallback", async () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const valueEnc = await encryptSecret("fixture_account_value", key);
  const reader: CredentialReader = {
    credentials: async () => [{ id: "account_one", kind: "openai", valueEnc, status: "active" }],
    orgBoatKey: async () => null,
  };
  const scope = { userId: "user_one", orgId: "org_one" };
  const engine = { harness: "codex" as const, model: "gpt-6.1-sol", credentialId: "account_one" };
  expect(await preflightOttoEngine(reader, key, scope, engine)).toEqual({ ready: true });
  expect(await preflightOttoEngine(reader, key, scope, { ...engine, credentialId: "missing_account" })).toMatchObject({
    ready: false,
    error: "account_unavailable",
    connectUrl: expect.any(String),
  });
  expect(await preflightOttoEngine(reader, key, scope, { ...engine, model: "invalid model" })).toMatchObject({
    ready: false,
    error: "unsupported_engine",
  });
});

test("OpenCode preflight refuses undeclared endpoint models and plain-key catalog defaults", async () => {
  const key = Buffer.alloc(32, 8).toString("base64");
  const engine = { harness: "opencode" as const, model: "armada/deepseek-flash", credentialId: "account_one" };
  const scope = { userId: "user_one", orgId: "org_one" };
  const valueEnc = await encryptSecret("fixture_opencode_value", key);
  const reader: CredentialReader = {
    credentials: async () => [{ id: "account_one", kind: "opencode", valueEnc, status: "active" }],
    orgBoatKey: async () => null,
  };
  expect(await preflightOttoEngine(reader, key, scope, engine)).toMatchObject({
    ready: false,
    error: "unsupported_engine",
  });
  expect(await preflightOttoEngine(reader, key, scope, { ...engine, model: "opencode/example" })).toEqual({
    ready: true,
  });
});
