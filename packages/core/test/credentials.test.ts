import { expect, test } from "bun:test";
import { missingKeyMessage, missingKeys, resolveCredentials, STORED_KEYS } from "../src/credentials.ts";
import { EMPTY_PERSONAL_CONFIG } from "../src/machine.ts";

test("GitHub falls back from GITHUB_TOKEN to GH_TOKEN to the gh login, which is asked only when needed", () => {
  let asked = 0;
  const gh = () => {
    asked++;
    return "from-gh\n";
  };
  const first = resolveCredentials({ env: { GITHUB_TOKEN: "a", GH_TOKEN: "b" }, ghToken: gh });
  expect([first.githubToken, first.sources.githubToken]).toEqual(["a", { kind: "env", variable: "GITHUB_TOKEN" }]);
  expect(resolveCredentials({ env: { GITHUB_TOKEN: " ", GH_TOKEN: "b" }, ghToken: gh }).githubToken).toBe("b");
  expect(asked).toBe(0);
  const viaGh = resolveCredentials({ env: {}, ghToken: gh });
  expect([viaGh.githubToken, viaGh.sources.githubToken]).toEqual(["from-gh", { kind: "gh" }]);
  expect(resolveCredentials({ env: {} }).githubToken).toBeNull();
});

test("the environment beats the credentials file, which beats config.toml for the Turso URL", () => {
  const store = { LINEAR_API_KEY: "stored-linear", ARMADA_TURSO_URL: "libsql://stored", ARMADA_TURSO_TOKEN: " " };
  const personal = { ...EMPTY_PERSONAL_CONFIG, turso: { url: "libsql://personal" } };

  const c = resolveCredentials({ env: { LINEAR_API_KEY: " env-linear " }, store, personal });
  expect(c).toMatchObject({ linearApiKey: "env-linear", tursoUrl: "libsql://stored", tursoToken: null });
  expect(c.sources).toMatchObject({
    linearApiKey: { kind: "env", variable: "LINEAR_API_KEY" },
    tursoUrl: { kind: "store" },
    tursoToken: null,
  });

  const fromStore = resolveCredentials({ env: {}, store, personal });
  expect([fromStore.linearApiKey, fromStore.sources.linearApiKey]).toEqual(["stored-linear", { kind: "store" }]);

  const fromConfig = resolveCredentials({ env: {}, store: {}, personal });
  expect([fromConfig.tursoUrl, fromConfig.sources.tursoUrl]).toEqual([
    "libsql://personal",
    { kind: "config", key: "turso.url" },
  ]);
});

test("a missing key is reported by the variable to set, never by a value", () => {
  const c = resolveCredentials({ env: { ARMADA_TURSO_URL: "libsql://x" } });
  expect(missingKeys(c).map((k) => k.variable)).toEqual(["LINEAR_API_KEY", "ARMADA_TURSO_TOKEN"]);
  const message = missingKeyMessage(STORED_KEYS[0] ?? expect.unreachable());
  expect(message).toStartWith("LINEAR_API_KEY is not set.");
  expect(message).toContain("armada auth login");
});

test("the Armada API is built in unless ARMADA_API_URL or [api] url names another; ARMADA_API_KEY beats the stored sign-in", () => {
  const personal = { ...EMPTY_PERSONAL_CONFIG, api: { url: "https://armada.self-hosted.test" } };
  expect(resolveCredentials({ env: {} }).armadaApi).toEqual({
    url: "https://armada.thevibecompany.co",
    source: { kind: "default" },
  });
  expect(resolveCredentials({ env: {}, personal }).armadaApi.source).toEqual({ kind: "config", key: "api.url" });
  expect(resolveCredentials({ env: { ARMADA_API_URL: "http://localhost:4822" }, personal }).armadaApi).toEqual({
    url: "http://localhost:4822",
    source: { kind: "env", variable: "ARMADA_API_URL" },
  });

  expect(resolveCredentials({ env: {} }).armadaSignIn).toBeNull();
  const store = { ARMADA_SESSION_TOKEN: "stored-session", ARMADA_API_KEY: "armada_stored" };
  expect(resolveCredentials({ env: {}, store }).armadaSignIn).toEqual({
    kind: "session",
    token: "stored-session",
    source: { kind: "store" },
  });
  expect(resolveCredentials({ env: {}, store: { ARMADA_API_KEY: "armada_stored" } }).armadaSignIn).toMatchObject({
    kind: "api-key",
    key: "armada_stored",
  });
  expect(resolveCredentials({ env: { ARMADA_API_KEY: "armada_env" }, store }).armadaSignIn).toEqual({
    kind: "api-key",
    key: "armada_env",
    source: { kind: "env", variable: "ARMADA_API_KEY" },
  });
});

test("a stored sign-in is used only for the Armada that issued it; the environment's key goes anywhere", () => {
  const store = { ARMADA_SESSION_TOKEN: "stored-session", ARMADA_SIGNED_IN_TO: "https://armada.example.test/" };
  const there = resolveCredentials({ env: { ARMADA_API_URL: "https://armada.example.test" }, store });
  expect(there.armadaSignIn?.kind).toBe("session");
  const elsewhere = resolveCredentials({ env: {}, store });
  expect([elsewhere.armadaSignIn, elsewhere.armadaSignInElsewhere]).toEqual([null, "https://armada.example.test"]);
  const env = resolveCredentials({ env: { ARMADA_API_KEY: "armada_env" }, store });
  expect([env.armadaSignIn?.kind, env.armadaSignInElsewhere]).toEqual(["api-key", null]);
});
