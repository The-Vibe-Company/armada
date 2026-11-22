import { type AuthFetch, type AuthStore, assertSupabaseUrl, authenticate, bearerKind } from "@armada/auth";
import type { MemberRole } from "@armada/core";
import { decodeJwt } from "jose";
import { acceptsSessionClient, verifySessionJwt } from "./session-jwt.ts";

/**
 * Who one request is, and the orgs it may act in. An Armada token (service or OAuth access) is bound
 * to one org. A Supabase session (the dashboard, the CLI's login) is the person, in every org they belong to.
 */
export interface Caller {
  userId: string;
  orgs: readonly { orgId: string; role: MemberRole }[];
  orgNames?: Readonly<Record<string, string>>;
  key?: { name: string; expiresAt: string | null };
  via: "service" | "mcp" | "supabase";
}

export interface SupabaseProject {
  supabaseUrl: string;
  anonKey: string;
  cliOAuthClientId?: string | undefined;
  fetch?: AuthFetch;
}

export type CallerResult = { ok: true; caller: Caller } | { ok: false };

/** Thrown when Supabase or the token store cannot answer: the request may succeed later. */
export class AuthUnavailable extends Error {
  override readonly name = "AuthUnavailable";

  /** `cause` is the real failure, for the server's log. It never holds a token or a key. */
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** One line for the log: the message and the chain of causes. */
export function describeFailure(error: unknown): string {
  const parts: string[] = [];
  for (let current = error, depth = 0; current !== undefined && depth < 4; depth++) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" <- ");
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
    } catch (error) {
      throw new AuthUnavailable("The token store is unavailable.", error);
    }
    if (!result.ok) return { ok: false };
    const { userId, orgId, role, kind: via, key } = result.principal;
    return { ok: true, caller: { userId, orgs: [{ orgId, role }], via, ...(key ? { key } : {}) } };
  }
  if (!JWT.test(token)) return { ok: false };
  if (options.store.sessionMemberships) {
    let session: Awaited<ReturnType<typeof verifySessionJwt>>;
    try {
      session = await verifySessionJwt(token, options.supabase, options.now);
    } catch {
      throw new AuthUnavailable("Session signing keys are unavailable.");
    }
    if (session === null) return { ok: false };
    if (session) {
      try {
        const memberships = await options.store.sessionMemberships(
          session.userId,
          session.sessionId,
          options.now.toISOString(),
        );
        if (memberships === null) return { ok: false };
        return {
          ok: true,
          caller: {
            userId: session.userId,
            orgs: memberships.map(({ orgId, role }) => ({ orgId, role })),
            orgNames: Object.fromEntries(memberships.map(({ orgId, name }) => [orgId, name])),
            via: "supabase",
          },
        };
      } catch (error) {
        throw new AuthUnavailable("The session store is unavailable.", error);
      }
    }
  }
  const userId = await verifySupabaseUser(token, options.supabase);
  if (!userId) return { ok: false };
  let memberships: Awaited<ReturnType<AuthStore["memberships"]>>;
  try {
    memberships = await options.store.memberships(userId);
  } catch (error) {
    throw new AuthUnavailable("The membership store is unavailable.", error);
  }
  return {
    ok: true,
    caller: {
      userId,
      orgs: memberships.map(({ orgId, role }) => ({ orgId, role })),
      orgNames: Object.fromEntries(memberships.map(({ orgId, name }) => [orgId, name])),
      via: "supabase",
    },
  };
}

/**
 * The user id of a Supabase access token, checked by the issuing Supabase project, so a token
 * of another project, an expired one or a signed-out session is refused. Null when refused.
 * Unverified claims select the endpoint. The issuing project authenticates the same bearer.
 */
export async function verifySupabaseUser(token: string, project: SupabaseProject): Promise<string | null> {
  let client: unknown;
  try {
    client = decodeJwt(token).client_id;
  } catch {
    client = undefined;
  }
  if (!acceptsSessionClient(client, project.cliOAuthClientId)) return null;
  const oauth = client !== undefined;
  const endpoint = oauth ? "/oauth/userinfo" : "/user";
  const identityField = oauth ? "sub" : "id";
  const controller = new AbortController();
  let response: Response | undefined;
  const cancelBody = () => {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      cancelBody();
      reject(new AuthUnavailable("Supabase verification timed out."));
    }, 10_000);
  });
  const verify = async (): Promise<string | null> => {
    response = await (project.fetch ?? fetch)(`${assertSupabaseUrl(project.supabaseUrl)}/auth/v1${endpoint}`, {
      headers: { apikey: project.anonKey, authorization: `Bearer ${token}`, accept: "application/json" },
      signal: controller.signal,
    });
    // A custom transport may finish after cancellation. Do not consume its late response.
    if (controller.signal.aborted) {
      cancelBody();
      throw new AuthUnavailable("Supabase verification timed out.");
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      cancelBody();
      return null;
    }
    if (!response.ok) {
      cancelBody();
      throw new AuthUnavailable(`Supabase answered ${response.status}.`);
    }
    const user: unknown = await response.json();
    const id = typeof user === "object" && user !== null ? (user as Record<string, unknown>)[identityField] : undefined;
    if (typeof id !== "string" || !UUID.test(id)) {
      throw new AuthUnavailable("Supabase returned an invalid identity.");
    }
    return id.toLowerCase();
  };
  try {
    return await Promise.race([verify(), deadline]);
  } catch (error) {
    if (error instanceof AuthUnavailable) throw error;
    throw new AuthUnavailable("Supabase verification is unavailable.");
  } finally {
    clearTimeout(timer);
  }
}

export function bearerToken(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  return match?.[1] ?? null;
}
