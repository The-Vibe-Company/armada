import {
  AuthError,
  type AuthStore,
  BodyTooLargeError,
  createServiceToken,
  listServiceTokens,
  revokeServiceToken,
} from "@armada/auth";
import { VaultError } from "@armada/core/server";
import { AuthUnavailable } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { readBody } from "./control-body.ts";
import { authenticatedCaller, Unauthorized } from "./control-caller.ts";
import { optional, required, UUID } from "./control-input.ts";
import { fail, VAULT_STATUS as STATUS } from "./control-response.ts";

type TokenControlOptions = Pick<ControlOptions, "authStore" | "supabase" | "now">;

/** Only store I/O is a dependency failure; policy/validation errors stay outside this boundary. */
function tokenRouteStore(store: AuthStore): AuthStore {
  const dependency = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch {
      throw new AuthUnavailable("Token store unavailable.");
    }
  };
  return {
    ...store,
    memberships: (...args) => dependency(() => store.memberships(...args)),
    listServiceTokens: (...args) => dependency(() => store.listServiceTokens(...args)),
    insertToken: (...args) => dependency(() => store.insertToken(...args)),
    revokeToken: (...args) => dependency(() => store.revokeToken(...args)),
  };
}

function tokenRouteFailure(error: unknown, revoking = false): Response {
  if (error instanceof AuthUnavailable)
    return fail(503, "dependency_unavailable", "Token service is temporarily unavailable.");
  if (error instanceof Unauthorized) return fail(401, "unauthorized", "Run armada login.");
  if (error instanceof VaultError) return fail(STATUS[error.code], error.code, error.message);
  if (error instanceof AuthError)
    return revoking
      ? fail(403, "forbidden", "Token revocation was refused.")
      : fail(400, "invalid", "Invalid token request.");
  return fail(500, "internal", "The server could not complete the request.");
}

export async function tokenRevokeRoute(request: Request, options: TokenControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const store = tokenRouteStore(options.authStore);
    const body = await readBody(request);
    const id = required(body, "id");
    if (!UUID.test(id)) throw new VaultError("invalid", "id must be a token UUID.");
    if (caller.via !== "supabase") {
      const visible = await listServiceTokens(store, caller.userId);
      const target = visible.find((token) => token.id === id);
      const members = await store.memberships(caller.userId);
      const org = caller.orgs[0];
      if (!target || !org || !members.some((member) => member.orgId === org.orgId && member.name === target.orgName))
        return fail(403, "forbidden", "This token is scoped to another org.");
    }
    await revokeServiceToken(store, {
      userId: caller.userId,
      id,
      now: (options.now ?? (() => new Date()))(),
    });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    return tokenRouteFailure(error, true);
  }
}

export async function tokenCreateRoute(request: Request, options: TokenControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const store = tokenRouteStore(options.authStore);
    const body = await readBody(request);
    const ref = optional(body, "org") ?? optional(body, "orgName");
    if (body.org !== undefined && body.orgName !== undefined && body.org !== body.orgName)
      return fail(400, "invalid", "Conflicting org selectors.");
    const memberships = await store.memberships(caller.userId);
    const selected =
      ref === undefined
        ? undefined
        : memberships.find(
            (item) =>
              (item.orgId === ref || item.name.toLowerCase() === ref.toLowerCase()) &&
              caller.orgs.some((scope) => scope.orgId === item.orgId),
          );
    if (ref !== undefined && !selected) return fail(403, "forbidden", "This organization is not in your scope.");
    if (caller.via !== "supabase" && !selected)
      return fail(403, "forbidden", "A scoped token cannot create an unscoped token.");
    const org = selected?.name;
    const created = await createServiceToken(store, {
      userId: caller.userId,
      ...(org ? { orgName: org } : {}),
      ...(optional(body, "label") ? { label: optional(body, "label")! } : {}),
      now: (options.now ?? (() => new Date()))(),
    });
    return Response.json(
      { id: created.id, label: created.label, orgName: created.orgName, token: created.token },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    return tokenRouteFailure(error);
  }
}

export async function tokenListRoute(request: Request, options: TokenControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const store = tokenRouteStore(options.authStore);
    const tokens = await listServiceTokens(store, caller.userId);
    const allowed = caller.via !== "supabase" ? new Set(caller.orgs.map((org) => org.orgId)) : null;
    const memberships = allowed ? await store.memberships(caller.userId) : [];
    const names = new Set(
      memberships.filter((membership) => allowed?.has(membership.orgId)).map((membership) => membership.name),
    );
    return Response.json(
      {
        tokens: tokens
          .filter((token) => !allowed || names.has(token.orgName))
          .map(({ id, label, orgName, createdAt, revokedAt }) => ({ id, label, orgName, createdAt, revokedAt })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return tokenRouteFailure(error);
  }
}
