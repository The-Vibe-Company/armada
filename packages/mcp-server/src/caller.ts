import { type AuthFetch, type AuthStore, assertSupabaseUrl, authenticate, bearerKind } from "@armada/auth";
import type { MemberRole } from "@armada/core";

/**
 * Who one request is, and the orgs it may act in. An Armada token (service or OAuth access) is bound
 * to one org. A Supabase session (the dashboard, the CLI's login) is the person, in every org they belong to.
 */
export interface Caller {
  userId: string;
  orgs: readonly { orgId: string; role: MemberRole }[];
  via: "service" | "mcp" | "supabase";
}

export interface SupabaseProject {
  supabaseUrl: string;
  anonKey: string;
  fetch?: AuthFetch;
}

export type CallerResult = { ok: true; caller: Caller } | { ok: false };

/** Thrown when Supabase or the token store cannot answer: the request may succeed later. */
export class AuthUnavailable extends Error {
  override readonly name = "AuthUnavailable";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Reads the bearer of one request, with no cache: a revoked token, a signed-out session or a removed membership fails the next call. */
export async function authenticateCaller(
  authorization: string | null,
  options: { store: AuthStore; supabase: SupabaseProject; now: Date },
): Promise<CallerResult> {
  const token = bearerToken(authorization);
  if (!token) return { ok: false };
  const kind = bearerKind(token);
  if (kind === "service" || kind === "access") {
    let result: Awaited<ReturnType<typeof authenticate>>;
    try {
      result = await authenticate(authorization, options.store, options.now);
    } catch {
      throw new AuthUnavailable("The token store is unavailable.");
    }
    if (!result.ok) return { ok: false };
    const { userId, orgId, role, kind: via } = result.principal;
    return { ok: true, caller: { userId, orgs: [{ orgId, role }], via } };
  }
  if (!JWT.test(token)) return { ok: false };
  const userId = await verifySupabaseUser(token, options.supabase);
  if (!userId) return { ok: false };
  let memberships: Awaited<ReturnType<AuthStore["memberships"]>>;
  try {
    memberships = await options.store.memberships(userId);
  } catch {
    throw new AuthUnavailable("The membership store is unavailable.");
  }
  return {
    ok: true,
    caller: { userId, orgs: memberships.map(({ orgId, role }) => ({ orgId, role })), via: "supabase" },
  };
}

/**
 * The user id of a Supabase access token, checked by the project itself (`/auth/v1/user`), so a token
 * of another project, an expired one or a signed-out session is refused. Null when refused.
 */
export async function verifySupabaseUser(token: string, project: SupabaseProject): Promise<string | null> {
  let response: Response;
  try {
    response = await (project.fetch ?? fetch)(`${assertSupabaseUrl(project.supabaseUrl)}/auth/v1/user`, {
      headers: { apikey: project.anonKey, authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch {
    throw new AuthUnavailable("Supabase is unreachable.");
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new AuthUnavailable(`Supabase answered ${response.status}.`);
  const user: unknown = await response.json().catch(() => null);
  const id = typeof user === "object" && user !== null && "id" in user ? user.id : undefined;
  return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
}

export function bearerToken(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  return match?.[1] ?? null;
}
