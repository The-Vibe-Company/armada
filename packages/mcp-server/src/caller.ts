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
    const { userId, orgId, role, kind: via } = result.principal;
    return { ok: true, caller: { userId, orgs: [{ orgId, role }], via } };
  }
  if (!JWT.test(token)) return { ok: false };
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
    caller: { userId, orgs: memberships.map(({ orgId, role }) => ({ orgId, role })), via: "supabase" },
  };
}

/**
 * The user id of a Supabase access token, checked by the project itself (`/auth/v1/user`), so a token
 * of another project, an expired one or a signed-out session is refused. Null when refused.
 */
export async function verifySupabaseUser(token: string, project: SupabaseProject): Promise<string | null> {
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
    response = await (project.fetch ?? fetch)(`${assertSupabaseUrl(project.supabaseUrl)}/auth/v1/user`, {
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
    const id = typeof user === "object" && user !== null && "id" in user ? user.id : undefined;
    if (typeof id !== "string" || !UUID.test(id)) {
      throw new AuthUnavailable("Supabase returned an invalid identity.");
    }
    return id.toLowerCase();
  };
  try {
    // The deadline covers both headers and the entire JSON body, even for custom transports.
    return await Promise.race([verify(), deadline]);
  } catch (error) {
    if (error instanceof AuthUnavailable) throw error;
    // Transport/parser exceptions can include response contents or request credentials.
    throw new AuthUnavailable("Supabase verification is unavailable.");
  } finally {
    clearTimeout(timer);
  }
}

export function bearerToken(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  return match?.[1] ?? null;
}
