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
