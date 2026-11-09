import { describe, expect, test } from "bun:test";
import { bindableStatus, compatibleAccounts, needsAccountChoice } from "../src/lib/account-recovery.ts";

const ORG = "00000000-0000-4000-8000-000000000010";
const now = new Date("2026-11-10T12:00:00Z");
const row = (id: string, kind: string, fields: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000${id}`,
  kind,
  name: `Account ${id}`,
  status: "active",
  isDefault: false,
  version: 1,
  createdAt: null,
  ...fields,
});

describe("legacy account recovery", () => {
  test("only active, unexpired accounts of the harness's kinds are offered: personal first, then the sandbox's org", () => {
    const list = {
      user: [
        row("01", "anthropic", { isDefault: true }),
        row("02", "openai"),
        row("03", "claude_oauth", { status: "revoked" }),
        row("04", "claude_oauth", { expiresAt: "2026-11-10T11:59:59Z" }),
        { kind: "claude_oauth", createdAt: "2026-01-01T00:00:00Z" },
        row("05", "boat"),
      ],
      orgs: [
        { id: ORG, name: "Acme", credentials: [{ kind: "boat", createdAt: null }, row("06", "claude_oauth")] },
        { id: "00000000-0000-4000-8000-000000000011", credentials: [row("07", "claude_oauth")] },
      ],
    };
    expect(compatibleAccounts(list, "claude", ORG, now)).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Account 01",
        kind: "anthropic",
        kindLabel: "Anthropic API key",
        scope: "user",
        isDefault: true,
      },
      {
        id: "00000000-0000-4000-8000-000000000006",
        name: "Account 06",
        kind: "claude_oauth",
        kindLabel: "Claude Code OAuth token",
        scope: "org",
        isDefault: false,
      },
    ]);
    expect(compatibleAccounts(list, "codex", ORG, now).map((item) => item.name)).toEqual(["Account 02"]);
    expect(compatibleAccounts(null, "codex", ORG, now)).toEqual([]);
  });

  test("only a Modal sandbox recorded without an account needs a choice", () => {
    const base = { provider: "modal", owner_id: "u", status: "stopped" as const };
    expect(needsAccountChoice({ ...base, credential_id: null })).toBe(true);
    expect(needsAccountChoice({ ...base, credential_id: "00000000-0000-4000-8000-000000000001" })).toBe(false);
    expect(needsAccountChoice({ ...base, provider: "boat", credential_id: null })).toBe(false);
    // A database before the #603 migration has no column: never mistaken for an unbound sandbox.
    expect(needsAccountChoice(base)).toBe(false);
    expect(needsAccountChoice({ ...base, status: "deleted", credential_id: null })).toBe(false);
  });

  test("only a stopped sandbox is offered the bind, as the server accepts no other state", () => {
    expect(bindableStatus("stopped")).toBe("ready");
    expect(bindableStatus("stopping")).toBe("wait");
    for (const status of ["starting", "ready", "running"] as const) expect(bindableStatus(status)).toBe("stop-first");
    // Stop does not apply to a failed sandbox and the server refuses to bind one: never offer a doomed choice.
    expect(bindableStatus("failed")).toBe("failed");
  });
});
