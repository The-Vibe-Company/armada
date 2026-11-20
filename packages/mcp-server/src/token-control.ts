import { AuthError, type AuthStore, BodyTooLargeError, createServiceToken, revokeServiceToken } from "@armada/auth";
import { controlRouteKey, tokenOperations } from "@armada/core/contract";
import { VaultError } from "@armada/core/server";
import type { z } from "zod";
import { AuthUnavailable } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { readBody } from "./control-body.ts";
import { authenticatedCaller, Unauthorized } from "./control-caller.ts";
import { fail, INTERNAL_FAILURE_MESSAGE, VAULT_STATUS as STATUS } from "./control-response.ts";
import { recordOperatorFailure } from "./request-observability.ts";
import { defineRoutes } from "./routes.ts";

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
  if (error instanceof Unauthorized) return fail(401, "unauthorized", error.message);
  if (error instanceof VaultError) return fail(STATUS[error.code], error.code, error.message);
  if (error instanceof AuthError)
    return revoking
      ? fail(403, "forbidden", "Token revocation was refused.")
      : fail(400, "invalid", "Invalid token request.");
  recordOperatorFailure("control.token", error);
  return fail(500, "internal", INTERNAL_FAILURE_MESSAGE);
}

const { listServiceTokens: list, createServiceToken: create, revokeServiceToken: revoke, whoami } = tokenOperations;

function parseTokenInput<T>(schema: z.ZodType<T>, input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new VaultError("invalid", parsed.error.issues[0]!.message);
  return parsed.data;
}

function tokenResponse(data: unknown) {
  return Response.json(data, { headers: { "cache-control": "no-store" } });
}

async function loginCaller(request: Request, options: TokenControlOptions) {
  const caller = await authenticatedCaller(request, options);
  if (caller.via !== "supabase") throw new VaultError("forbidden", "Managing API keys requires a personal login.");
  return caller;
}

async function tokenRevokeRoute(request: Request, options: TokenControlOptions): Promise<Response> {
  try {
    const caller = await loginCaller(request, options);
    const { id } = parseTokenInput(revoke.input.body, await readBody(request));
    await revokeServiceToken(tokenRouteStore(options.authStore), {
      userId: caller.userId,
      id,
      now: options.now?.() ?? new Date(),
    });
    return tokenResponse({ ok: true });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    return tokenRouteFailure(error, true);
  }
}

const expiryDays = { "30d": 30, "90d": 90, "1y": 365 } as const;

async function tokenCreateRoute(request: Request, options: TokenControlOptions): Promise<Response> {
  try {
    const caller = await loginCaller(request, options);
    const { org, label, expires } = parseTokenInput(create.input.body, await readBody(request));
    const orgs = caller.orgs.filter(
      ({ orgId }) =>
        org === undefined || orgId === org || caller.orgNames?.[orgId]?.toLowerCase() === org.toLowerCase(),
    );
    const selected = orgs[0];
    if (!selected || orgs.length !== 1) {
      return org === undefined
        ? fail(400, "invalid", "Choose an organization for this API key.")
        : fail(403, "forbidden", "This organization is not in your scope.");
    }
    const now = options.now?.() ?? new Date();
    const expiresAt =
      expires === "never" ? null : new Date(now.getTime() + expiryDays[expires] * 86_400_000).toISOString();
    return tokenResponse(
      await createServiceToken(tokenRouteStore(options.authStore), {
        userId: caller.userId,
        orgName: selected.orgId,
        label,
        now,
        expiresAt,
      }),
    );
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    return tokenRouteFailure(error);
  }
}

async function tokenListRoute(request: Request, options: TokenControlOptions): Promise<Response> {
  try {
    const caller = await loginCaller(request, options);
    const tokens = await tokenRouteStore(options.authStore).listServiceTokens(caller.userId);
    return tokenResponse({ tokens });
  } catch (error) {
    return tokenRouteFailure(error);
  }
}

async function whoamiRoute(request: Request, options: TokenControlOptions) {
  try {
    const { userId, via, key } = await authenticatedCaller(request, options);
    if (via === "supabase") return tokenResponse({ userId, auth: "login" });
    if (key) return tokenResponse({ userId, auth: "key", key });
    return fail(403, "forbidden", "Use a personal login or an Armada API key.");
  } catch (error) {
    return tokenRouteFailure(error);
  }
}

export const tokenRoutes = defineRoutes("token", {
  [controlRouteKey(list.route)]: { methods: [list.route.method], respond: tokenListRoute },
  [controlRouteKey(create.route)]: { methods: [create.route.method], respond: tokenCreateRoute },
  [controlRouteKey(revoke.route)]: { methods: [revoke.route.method], respond: tokenRevokeRoute },
  [controlRouteKey(whoami.route)]: { methods: [whoami.route.method], respond: whoamiRoute },
});
