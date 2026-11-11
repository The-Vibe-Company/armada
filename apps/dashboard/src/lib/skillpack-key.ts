import { parseCredentialValue, VaultError } from "@armada/core";

/**
 * The Skillpack key (#957): the read-only personal access token Armada uses to install private skills. One per
 * person and one per organization, set, replaced and removed through the existing credential routes of the control
 * API as the signed-in viewer. It is write-only: `creds/list` answers its kind and dates, never its value.
 */
export const SKILLS_PATH = "/skills";

export const SKILLPACK_ROUTES = { list: "creds/list", set: "creds/set", remove: "creds/rm" } as const;

/** The credential kind's name on the control API. */
export const SKILLPACK_KIND = "skillpack";

/** The only scope Armada accepts on the key. */
export const SKILLPACK_SCOPE = "skills:read";

export type SkillpackScope = "user" | "org";

/** What the page knows of a stored key: when it was set, and whether it can still be used. */
export type SkillpackKey = { setAt: string | null; usable: boolean };

export type SkillpackKeys = { user: SkillpackKey | null; org: SkillpackKey | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The key among one scope's credentials, or null. An expired or revoked one is still listed, as needing a new key. */
function keyOf(credentials: unknown, now: number): SkillpackKey | null {
  if (!Array.isArray(credentials)) return null;
  const row = credentials.find((item) => isRecord(item) && item.kind === SKILLPACK_KIND && item.status !== "deleted");
  if (!isRecord(row)) return null;
  const date = [row.updatedAt, row.createdAt].find((value): value is string => typeof value === "string") ?? null;
  const expires = typeof row.expiresAt === "string" ? Date.parse(row.expiresAt) : Number.NaN;
  const usable = (row.status === undefined || row.status === "active") && !(expires <= now);
  return { setAt: date, usable };
}

/** The viewer's own key and the selected organization's, from a `creds/list` answer. */
export function skillpackKeysFromList(payload: unknown, org: string, now: number): SkillpackKeys {
  const record = isRecord(payload) ? payload : {};
  const orgs = Array.isArray(record.orgs) ? record.orgs : [];
  const mine = orgs.find((item) => isRecord(item) && item.id === org);
  return { user: keyOf(record.user, now), org: keyOf(isRecord(mine) ? mine.credentials : undefined, now) };
}

/** A pasted key, checked with the server's own parser before it is sent. The error never repeats the value. */
export function checkSkillpackKey(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "Paste the key to store." };
  try {
    return { ok: true, value: parseCredentialValue("skillpack", raw) };
  } catch (error) {
    if (error instanceof VaultError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Who a key serves, in the words of its row. */
export function skillpackAudience(scope: SkillpackScope, orgName: string): string {
  return scope === "user" ? "Only you" : `Everyone in ${orgName}`;
}
