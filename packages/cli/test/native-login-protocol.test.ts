import { expect, test } from "bun:test";
import { NativeCodexLoginProtocol, validateNativeCodexAuth } from "../src/native-login-protocol.ts";

// Exact 0.166.0 JSON-RPC shapes, no provider/network/process or authorization in these tests.
const challenge = {
  id: 2,
  result: {
    type: "chatgptDeviceCode",
    loginId: "attempt",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  },
};
function started() {
  const sent: object[] = [],
    shown: string[][] = [];
  const protocol = new NativeCodexLoginProtocol(
    (v) => sent.push(v),
    (url, code) => shown.push([url, code]),
  );
  protocol.start();
  protocol.receive({ id: 1, result: { userAgent: "codex_cli_rs/0.166.0" } });
  return { protocol, sent, shown };
}
test("0.166 device protocol correlates only its own attempt and exposes only the official challenge", () => {
  const { protocol, sent, shown } = started();
  expect(sent).toEqual([
    {
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "armada-local-login", version: "1" }, capabilities: {} },
    },
    { method: "initialized", params: {} },
    { id: 2, method: "account/login/start", params: { type: "chatgptDeviceCode" } },
  ]);
  expect(protocol.receive({ id: 99, error: { message: "unrelated native error" } })).toBe(false);
  expect(protocol.receive({ method: "remoteControl/status/changed", params: { status: "disconnected" } })).toBe(false);
  expect(protocol.receive(challenge)).toBe(false);
  expect(shown).toEqual([["https://auth.openai.com/codex/device", "ABCD-EFGH"]]);
  expect(
    protocol.receive({
      method: "account/login/completed",
      params: { loginId: "attempt", success: true, error: null, onboardingEntrypoint: null },
    }),
  ).toBe(true);
  expect(protocol.stage).toContain("reading the approved");
});
for (const [native, expected] of [
  ["device auth timed out after 15 minutes", "device approval expired after 15 minutes"],
  ["device auth failed with status 429", "device authorization polling failed (HTTP 429)"],
  ['device code exchange failed: {"access_token":"fixture-sensitive"}', "authorization-code/token exchange failed"],
  ["workspace routing discovery unauthorized (401)", "workspace discovery was not authorized"],
  ["workspace routing discovery timed out", "workspace discovery timed out after approval"],
  ["workspace routing discovery failed", "workspace discovery failed after approval"],
  ["failed to load workspace requirements: fixture-sensitive", "workspace requirements could not be loaded"],
  ["account changed before sign-in completed", "selected account changed"],
  ["Login was not completed", "native sign-in did not complete"],
  ["fixture-sensitive", "unrecognized details withheld"],
] as const)
  test(`native completion failure distinguishes ${expected} without raw provider text`, () => {
    const { protocol } = started();
    protocol.receive(challenge);
    let message = "";
    try {
      protocol.receive({
        method: "account/login/completed",
        params: { loginId: "attempt", success: false, error: native },
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("Codex reported:");
    expect(message).toContain(expected);
    expect(message).toContain("waiting for browser approval and Codex account setup");
    expect(message).toContain("No account was published");
    expect(message).not.toContain("fixture-sensitive");
  });
test("JSON-RPC initialization error reports code and stage but never reflects its message", () => {
  const p = new NativeCodexLoginProtocol(
    () => {},
    () => {},
  );
  expect(() => p.receive({ id: 1, error: { code: -32602, message: "fixture-sensitive" } })).toThrow("JSON-RPC -32602");
  expect(() => p.receive({ id: 1, error: { message: "fixture-sensitive" } })).toThrow("initializing the app-server");
  try {
    p.receive({ id: 1, error: { message: "fixture-sensitive" } });
  } catch (e) {
    expect(String(e)).not.toContain("fixture-sensitive");
  }
});
test("an unsafe challenge and a different completion cannot authorize publication", () => {
  const { protocol, shown } = started();
  expect(() =>
    protocol.receive({
      id: 2,
      result: { ...challenge.result, verificationUrl: "https://evil.example/?key=fixture-sensitive" },
    }),
  ).toThrow("unsafe device challenge");
  expect(shown).toHaveLength(0);
  protocol.receive(challenge);
  expect(() =>
    protocol.receive({ method: "account/login/completed", params: { loginId: "other-attempt", success: true } }),
  ).toThrow("different or missing login");
});
for (const [field, expected] of [
  ["access_token", "no access token"],
  ["refresh_token", "no refresh token"],
  ["account_id", "no stable ChatGPT account ID"],
] as const)
  test(`approved native auth diagnoses ${field} instead of inventing a usable account`, () => {
    const tokens = {
      access_token: "fixture-sensitive-access",
      refresh_token: "fixture-sensitive-refresh",
      account_id: "fixture-account",
      [field]: null,
    };
    let message = "";
    try {
      validateNativeCodexAuth(JSON.stringify({ tokens }));
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("Codex approved the login");
    expect(message).toContain(expected);
    expect(message).toContain("No account was published");
    expect(message).not.toContain("fixture-sensitive");
  });
test("approved native auth validates JSON and subscription mode without echoing auth material", () => {
  expect(() => validateNativeCodexAuth('{"secret":"fixture-sensitive"')).toThrow("not valid JSON");
  expect(() =>
    validateNativeCodexAuth(
      JSON.stringify({
        OPENAI_API_KEY: "fixture-sensitive",
        tokens: { access_token: "a", refresh_token: "r", account_id: "id" },
      }),
    ),
  ).toThrow("not a ChatGPT subscription");
  const native =
    '{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"access_token":"a","refresh_token":"r","account_id":"id"}}';
  expect(validateNativeCodexAuth(native)).toBe(native);
});
test("parent hangup, cancellation, startup and approval deadlines identify the actual local step", () => {
  const { protocol } = started();
  const expired = new AbortController();
  expired.abort(new DOMException("fixture-sensitive", "TimeoutError"));
  expect(protocol.cancelled(expired.signal).message).toContain("30 seconds");
  protocol.receive(challenge);
  expect(protocol.cancelled(expired.signal).message).toContain("16 minutes");
  expect(protocol.cancelled(expired.signal).message).not.toContain("fixture-sensitive");
  for (const [reason, expected] of [
    ["SIGHUP", "parent shell/session closed"],
    ["SIGINT", "Ctrl-C"],
    ["SIGTERM", "terminated"],
  ] as const) {
    const c = new AbortController();
    c.abort(reason);
    expect(protocol.cancelled(c.signal).message).toContain(expected);
  }
  expect(protocol.exited(9, null).message).toContain("exit code 9");
  expect(protocol.exited(null, "SIGTERM").message).toContain("SIGTERM");
});
