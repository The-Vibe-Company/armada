import { bearerKind, sha256Hex } from "./codec.ts";
import { ACCESS_TOKEN_TTL_MS, assertPublicUrl } from "./limits.ts";
import type { AuthStore, MemberRole } from "./types.ts";

/**
 * Who a bearer token is. `authenticate` reads the token row on every call and
 * keeps no cache, so a revocation or a removed membership fails the next request.
 * #464 should not cache this result.
 */
export interface Principal {
  userId: string;
  orgId: string;
  tokenId: string;
  kind: "service" | "mcp";
  role: MemberRole;
}

export type AuthResult = { ok: true; principal: Principal } | { ok: false; error: "invalid_token" };

/**
 * Resolves `(user, org)` from an `Authorization: Bearer` header.
 * Service tokens do not expire. MCP access tokens expire an hour after `created_at`.
 * A refresh token is not a bearer.
 */
export async function authenticate(authorization: string | null, store: AuthStore, now: Date): Promise<AuthResult> {
  const token = bearer(authorization);
  const kind = token === null ? null : bearerKind(token);
  if (!token || (kind !== "service" && kind !== "access")) return { ok: false, error: "invalid_token" };
  const row = await store.findTokenByHash(kind === "service" ? "service" : "mcp", await sha256Hex(token));
  if (!row || row.revokedAt !== null) return { ok: false, error: "invalid_token" };
  if (kind === "access" && (row.label !== "access" || !fresh(row.createdAt, now, ACCESS_TOKEN_TTL_MS))) {
    return { ok: false, error: "invalid_token" };
  }
  const member = await store.membership(row.userId, row.orgId);
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

/** 401 that tells an MCP client where to start OAuth. */
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
