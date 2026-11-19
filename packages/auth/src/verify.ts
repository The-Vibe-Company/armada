import { bearerKind, sha256Hex } from "./codec.ts";
import { ACCESS_TOKEN_TTL_MS, assertPublicUrl } from "./limits.ts";
import type { AuthStore, MemberRole } from "./types.ts";

interface Principal {
  userId: string;
  orgId: string;
  tokenId: string;
  kind: "service" | "mcp";
  role: MemberRole;
}

type AuthResult = { ok: true; principal: Principal } | { ok: false; error: "invalid_token" };

export async function authenticate(authorization: string | null, store: AuthStore, now: Date): Promise<AuthResult> {
  const token = bearer(authorization);
  const kind = token === null ? null : bearerKind(token);
  if (!token || (kind !== "service" && kind !== "access")) return { ok: false, error: "invalid_token" };
  const table = kind === "service" ? "service" : "mcp";
  const hash = await sha256Hex(token);
  const joined = store.findTokenWithMembership ? await store.findTokenWithMembership(table, hash) : undefined;
  const row = joined === undefined ? await store.findTokenByHash(table, hash) : joined?.token;
  if (!row || row.revokedAt !== null) return { ok: false, error: "invalid_token" };
  if (kind === "access" && (row.label !== "access" || !fresh(row.createdAt, now, ACCESS_TOKEN_TTL_MS))) {
    return { ok: false, error: "invalid_token" };
  }
  const member = joined === undefined ? await store.membership(row.userId, row.orgId) : joined;
  if (!member) return { ok: false, error: "invalid_token" };
  return {
    ok: true,
    principal: {
      userId: row.userId,
      orgId: row.orgId,
      tokenId: row.id,
      kind: kind === "service" ? "service" : "mcp",
      role: member.role,
    },
  };
}

export function oauthChallenge(publicUrl: string): Response {
  const origin = assertPublicUrl(publicUrl);
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "www-authenticate": `Bearer realm="armada", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  });
}

export function fresh(createdAt: string, now: Date, ttlMs: number): boolean {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  return now.getTime() - created < ttlMs;
}

function bearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
