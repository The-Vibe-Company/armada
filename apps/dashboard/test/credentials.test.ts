import { describe, expect, test } from "bun:test";
import { CREDENTIAL_KINDS, checkSecretValue, credentialKindInfo, isCredentialKind } from "../src/lib/credentials.ts";

describe("credentials", () => {
  test("the kinds are the schema's kinds, each injected under its own variable", () => {
    expect(CREDENTIAL_KINDS.map((item) => item.kind)).toEqual(["claude_oauth", "anthropic", "openai", "boat"]);
    expect(credentialKindInfo("claude_oauth").env).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(credentialKindInfo("openai").env).toBe("OPENAI_API_KEY");
    expect(isCredentialKind("opencode")).toBe(false);
  });

  test("a pasted value is trimmed, and an empty or spaced one is refused", () => {
    expect(checkSecretValue("  sk-123\n")).toEqual({ ok: true, value: "sk-123" });
    expect(checkSecretValue("   ")).toMatchObject({ ok: false });
    expect(checkSecretValue(null)).toMatchObject({ ok: false });
    expect(checkSecretValue("two words")).toMatchObject({ ok: false });
    expect(checkSecretValue("x".repeat(9000))).toMatchObject({ ok: false });
  });
});
