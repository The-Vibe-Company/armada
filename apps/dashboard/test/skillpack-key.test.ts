import { expect, test } from "bun:test";
import { checkSkillpackKey, skillpackKeysFromList } from "../src/lib/skillpack-key.ts";

const ORG = "00000000-0000-4000-8000-000000000010";
const OTHER = "00000000-0000-4000-8000-000000000011";
const NOW = Date.parse("2026-11-11T12:00:00Z");
const KEY = `cmp_pat_${"a1".repeat(24)}`;

test("the key of each scope is read from creds/list as dates and state only, beside model accounts", () => {
  const keys = skillpackKeysFromList(
    {
      user: [
        { id: "x", kind: "claude_oauth", name: "Work", status: "active", updatedAt: "2026-10-01T00:00:00Z" },
        { kind: "skillpack", status: "active", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
      ],
      orgs: [
        { id: OTHER, credentials: [{ kind: "skillpack", status: "active", createdAt: "2026-09-01T00:00:00Z" }] },
        { id: ORG, credentials: [{ kind: "boat", createdAt: null }] },
      ],
    },
    ORG,
    NOW,
  );
  // The latest change is the date shown; another organization's key is not the selected one's.
  expect(keys).toEqual({ user: { setAt: "2026-11-02T00:00:00Z", usable: true }, org: null });
});

test("a revoked, expired or deleted key is not usable or not there; an unreadable answer holds no key", () => {
  const list = (row: Record<string, unknown>) =>
    skillpackKeysFromList({ user: [{ kind: "skillpack", createdAt: "2026-11-01T00:00:00Z", ...row }] }, ORG, NOW).user;
  expect(list({ status: "revoked" })?.usable).toBe(false);
  expect(list({ status: "active", expiresAt: "2026-11-10T00:00:00Z" })?.usable).toBe(false);
  expect(list({ status: "active", expiresAt: "2027-01-01T00:00:00Z" })?.usable).toBe(true);
  // An older server sends no status: a listed key is in use.
  expect(list({})?.usable).toBe(true);
  expect(list({ status: "deleted" })).toBeNull();
  expect(skillpackKeysFromList(null, ORG, NOW)).toEqual({ user: null, org: null });
});

test("a pasted key is checked with the server's parser, trimmed, and an error never repeats it", () => {
  expect(checkSkillpackKey(`  ${KEY}\n`)).toEqual({ ok: true, value: KEY });
  expect(checkSkillpackKey("   ")).toEqual({ ok: false, error: "Paste the key to store." });
  expect(checkSkillpackKey(null)).toEqual({ ok: false, error: "Paste the key to store." });
  const wrong = "ghp_not-a-skillpack-key-e2e";
  const refused = checkSkillpackKey(wrong);
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.error).toContain("cmp_pat_");
    expect(refused.error).not.toContain(wrong);
  }
});
