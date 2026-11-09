import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_KINDS,
  checkModalToken,
  checkSecretValue,
  credentialKindInfo,
  isCredentialKind,
} from "../src/lib/credentials.ts";

describe("credentials", () => {
  test("model keys name the variable a sandbox gets; hosting credentials name none", () => {
    expect(CREDENTIAL_KINDS.map((item) => item.kind)).toEqual(["claude_oauth", "anthropic", "openai", "boat", "modal"]);
    expect(credentialKindInfo("claude_oauth").env).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(credentialKindInfo("openai").env).toBe("OPENAI_API_KEY");
    // Hosting credentials stay on the server: no sandbox gets them as a variable.
    expect(credentialKindInfo("boat")).toMatchObject({ use: "hosting", env: null });
    expect(credentialKindInfo("modal")).toMatchObject({ use: "hosting", env: null });
    expect(isCredentialKind("opencode")).toBe(false);
  });

  test("a pasted value is trimmed, and an empty or spaced one is refused", () => {
    expect(checkSecretValue("  sk-123\n")).toEqual({ ok: true, value: "sk-123" });
    expect(checkSecretValue("   ")).toMatchObject({ ok: false });
    expect(checkSecretValue(null)).toMatchObject({ ok: false });
    expect(checkSecretValue("two words")).toMatchObject({ ok: false });
    expect(checkSecretValue("x".repeat(9000))).toMatchObject({ ok: false });
  });

  test("a Modal token is its two halves, checked together and stored as the canonical pair", () => {
    const id = "ak-AbCdEf123456";
    const secret = "as-ZyXwVu987654";
    expect(checkModalToken(` ${id} `, `${secret}\n`)).toEqual({
      ok: true,
      value: JSON.stringify({ token_id: id, token_secret: secret }),
    });
    expect(checkModalToken("", secret)).toEqual({ ok: false, error: "Enter the Modal token ID (ak-…)." });
    expect(checkModalToken(id, "  ")).toEqual({ ok: false, error: "Enter the Modal token secret (as-…)." });
    for (const [badId, badSecret] of [
      [secret, id],
      ["sk-AbCdEf123456", secret],
      [id, "as-short"],
      [`${id} extra`, secret],
    ] as const) {
      const checked = checkModalToken(badId, badSecret);
      expect(checked.ok).toBe(false);
      // The refusal never repeats what was typed.
      expect(JSON.stringify(checked)).not.toMatch(/AbCdEf123456|ZyXwVu987654/);
    }
  });
});
