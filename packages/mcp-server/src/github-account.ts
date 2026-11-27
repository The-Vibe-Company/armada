import {
  controlRouteKey,
  githubCallbackOperations,
  githubReposOperation,
  githubReposRequest,
  githubReposResponse,
} from "@armada/core/contract";
import {
  createSqlVaultStore,
  encryptSecret,
  exchangeGitHubCode,
  fetchGitHubInstallationRepositories,
  fetchGitHubInstallations,
  fetchGitHubUser,
  GITHUB_AUTHORIZE_URL,
  type GitHubApp,
  GitHubAuthError,
  type GitHubInstallation,
  resolveGitHubAccess,
  type Sql,
  serializeGitHubInstallations,
  VaultError,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { dashboardOrigin } from "./config.ts";
import type { ControlOptions } from "./control.ts";
import { fail } from "./control-response.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

export interface GitHubAccountApi {
  command(action: string, caller: Caller, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  callback(request: Request): Promise<Response>;
}
const hash = async (state: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state))).toString("hex");

/** Persistent one-use OAuth state binds the browser callback to the initiating Armada account. */
export function createGitHubAccountApi(options: {
  sql: Sql;
  app: GitHubApp | null;
  dashboardUrl?: string;
  development?: boolean;
  encryptionKey: string;
  slug?: string;
  appId?: string | number;
  reposTimeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}): GitHubAccountApi {
  const { sql } = options;
  const now = options.now ?? (() => new Date());
  const redirectUri = new URL("/github/callback", dashboardOrigin(options.dashboardUrl, options.development)).href;
  const rawSlug = options.slug?.trim();
  const appSlug = rawSlug && /^[A-Za-z0-9-]+$/.test(rawSlug) ? rawSlug : undefined;
  const rawAppId = options.appId === undefined ? "" : String(options.appId).trim();
  const appId = /^[1-9][0-9]{0,15}$/.test(rawAppId) && Number.isSafeInteger(Number(rawAppId)) ? rawAppId : undefined;
  const installUrl = appSlug ? `https://github.com/apps/${appSlug}/installations/new` : null;
  const reposTimeoutMs =
    options.reposTimeoutMs !== undefined && Number.isFinite(options.reposTimeoutMs) && options.reposTimeoutMs > 0
      ? Math.trunc(options.reposTimeoutMs)
      : 20_000;
  function filterAppInstallations(list: readonly GitHubInstallation[]) {
    const seen = new Set<number>();
    return list.filter((item) => {
      if (seen.has(item.id)) return false;
      if (appSlug && item.appSlug.toLowerCase() !== appSlug.toLowerCase()) return false;
      if (appId && String(item.appId) !== appId) return false;
      seen.add(item.id);
      return true;
    });
  }
  async function persistInstallations(userId: string, live: readonly GitHubInstallation[], expectedEpoch?: string) {
    try {
      if (expectedEpoch && sql.transaction) {
        await sql.transaction(async (tx) => {
          const current = (
            await tx.query<{ connection_epoch: string; revoked_at: unknown }>(
              "select connection_epoch, revoked_at from public.github_connections where user_id = $1::uuid for update",
              [userId],
            )
          ).rows[0];
          if (!current || current.revoked_at || current.connection_epoch !== expectedEpoch) return;
          await createSqlVaultStore(tx).updateGitHubInstallations(userId, live);
        });
      } else {
        await createSqlVaultStore(sql).updateGitHubInstallations(userId, live);
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "github_installations_persist_failed",
          ownerId: userId,
          count: live.length,
          reason: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }
  async function startAuthorizationFlow(userId: string) {
    if (!options.app) throw new VaultError("unavailable", "GitHub App authorization is not configured.");
    if (!sql.transaction) throw new VaultError("unavailable", "Transactional account storage is required.");
    const state = CLI_GITHUB_STATE_PREFIX + crypto.randomUUID() + crypto.randomUUID();
    const flowId = crypto.randomUUID();
    await sql.transaction(async (tx) => {
      await tx.query("select id from auth.users where id = $1::uuid for update", [userId]);
      await tx.query(
        "delete from public.github_authorizations where user_id = $1::uuid and (expires_at < $2 or status in ('pending','processing'))",
        [userId, now()],
      );
      await tx.query(
        "insert into public.github_authorizations(id,user_id,state_hash,status,expires_at) values ($1,$2,$3,'pending',$4)",
        [flowId, userId, await hash(state), new Date(now().getTime() + 600_000)],
      );
    });
    return { app: options.app, flowId, state };
  }
  async function metadata(userId: string) {
    const row = (
      await sql.query<{
        login: string;
        name: string | null;
        github_id: number;
        revoked_at: unknown;
        installations: unknown;
      }>(
        "select login, name, github_id, revoked_at, installations from public.github_connections where user_id = $1::uuid",
        [userId],
      )
    ).rows[0];
    const access = await resolveGitHubAccess(
      {
        caller: "account_status",
        store: createSqlVaultStore(sql),
        encryptionKey: options.encryptionKey,
        app: options.app,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        now,
      },
      userId,
    );
    let installations: unknown = row?.installations ?? [];
    let status: string = access.status === "revoked" ? "needs_reconnect" : access.status;
    if (access.status === "connected") {
      try {
        const live = filterAppInstallations(
          await fetchGitHubInstallations(access.token, options.fetch ? { fetch: options.fetch } : {}),
        );
        installations = serializeGitHubInstallations(live);
        await persistInstallations(userId, live, access.connectionEpoch);
      } catch {
        status = "unavailable";
      }
    }
    return {
      status,
      login: row?.login ?? null,
      name: row?.name ?? null,
      githubId: row?.github_id ?? null,
      installations,
      installUrl,
      configured: options.app !== null,
    };
  }
  return {
    async command(action, caller, body, signal) {
      if (caller.via !== "supabase")
        throw new VaultError("forbidden", "Sign in as a person to manage your GitHub account.");
      if (action === "status") {
        if (body.flowId !== undefined) {
          if (typeof body.flowId !== "string") throw new VaultError("invalid", "flowId must be text.");
          const flow = (
            await sql.query<{ status: string; expires_at: Date | string }>(
              "select status, expires_at from public.github_authorizations where id = $1::uuid and user_id = $2::uuid",
              [body.flowId, caller.userId],
            )
          ).rows[0];
          if (!flow) throw new VaultError("not_found", "No such authorization.");
          return {
            flowStatus:
              new Date(flow.expires_at).getTime() <= now().getTime() && flow.status !== "connected"
                ? "expired"
                : flow.status,
            connection: await metadata(caller.userId),
          };
        }
        return { connection: await metadata(caller.userId) };
      }
      if (action === "repos") {
        const parsed = githubReposRequest.safeParse(body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const path = issue?.path.join(".");
          throw new VaultError(
            "invalid",
            issue ? `${path ? `${path}: ` : ""}${issue.message}` : "Invalid GitHub repository filter.",
          );
        }
        if (!options.app) throw new VaultError("unavailable", "GitHub App authorization is not configured.");
        const access = await resolveGitHubAccess(
          {
            caller: "account_status",
            store: createSqlVaultStore(sql),
            encryptionKey: options.encryptionKey,
            app: options.app,
            ...(options.fetch ? { fetch: options.fetch } : {}),
            now,
          },
          caller.userId,
        );
        if (access.status === "not_connected")
          throw new VaultError(
            "forbidden",
            "GitHub is not connected. Connect GitHub in Settings or run `armada account login github`.",
          );
        if (access.status === "revoked")
          throw new VaultError(
            "forbidden",
            "Your GitHub connection was revoked or has expired. Reconnect GitHub in Settings or run `armada account login github`.",
          );
        if (access.status !== "connected")
          throw new VaultError("unavailable", "GitHub connection is temporarily unavailable. Retry shortly.");
        const fetchImpl = options.fetch ?? fetch;
        const timeoutSignal = AbortSignal.timeout(reposTimeoutMs);
        const requestSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
        const boundedFetch = ((input: string | URL | Request, init?: RequestInit) => {
          const combined = init?.signal ? AbortSignal.any([requestSignal, init.signal]) : requestSignal;
          if (combined.aborted)
            return Promise.reject(combined.reason ?? new DOMException("The operation was aborted.", "AbortError"));
          return fetchImpl(input, { ...init, signal: combined });
        }) as typeof fetch;
        try {
          const listed = await fetchGitHubInstallationRepositories(access.token, {
            ...(appId ? { appId } : {}),
            ...(appSlug ? { appSlug } : {}),
            ...(parsed.data.account ? { account: parsed.data.account } : {}),
            ...(parsed.data.query !== undefined ? { query: parsed.data.query } : {}),
            ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
            fetch: boundedFetch,
          });
          return githubReposResponse.parse(listed);
        } catch (error) {
          if (
            error instanceof GitHubAuthError ||
            requestSignal.aborted ||
            (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
          )
            throw new VaultError("unavailable", "GitHub repositories are temporarily unavailable. Retry shortly.");
          throw error;
        }
      }
      if (action === "disconnect") {
        if (!sql.transaction) throw new VaultError("unavailable", "Transactional account storage is required.");
        await sql.transaction(async (tx) => {
          await tx.query("select id from auth.users where id = $1::uuid for update", [caller.userId]);
          await tx.query("delete from public.github_authorizations where user_id = $1::uuid", [caller.userId]);
          await tx.query("delete from public.github_connections where user_id = $1::uuid", [caller.userId]);
        });
        console.error(
          JSON.stringify({
            event: "github_connection_disconnected",
            caller: "account_disconnect",
            ownerId: caller.userId,
            reason: "user_disconnect",
          }),
        );
        return { ok: true };
      }
      if (action === "install") {
        if (!installUrl) throw new VaultError("unavailable", "GitHub App installation is not configured.");
        const { flowId, state } = await startAuthorizationFlow(caller.userId);
        const url = new URL(installUrl);
        url.searchParams.set("state", state);
        return { flowId, authorizationUrl: url.href };
      }
      if (action === "connect" || action === "reconnect") {
        const { app, flowId, state } = await startAuthorizationFlow(caller.userId);
        const url = new URL(GITHUB_AUTHORIZE_URL);
        url.searchParams.set("client_id", app.clientId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("state", state);
        return { flowId, authorizationUrl: url.href };
      }
      throw new VaultError("not_found", "Unknown GitHub account action.");
    },
    async callback(request) {
      const fail = () => callbackResult(false);
      if (!options.app || !sql.transaction) return fail();
      let input: { state: string; code: string };
      try {
        input = await callbackInput(request);
      } catch {
        return fail();
      }
      const { state, code } = input;
      let flow: { id: string; user_id: string } | undefined;
      try {
        flow = (
          await sql.query<{ id: string; user_id: string }>(
            "update public.github_authorizations set status = 'processing' where state_hash = $1 and status = 'pending' and expires_at > $2 returning id,user_id",
            [await hash(state), now()],
          )
        ).rows[0];
      } catch {
        return fail();
      }
      if (!flow) return fail();
      try {
        const tokens = await exchangeGitHubCode(
          options.app,
          { code, redirectUri },
          { ...(options.fetch ? { fetch: options.fetch } : {}), now },
        );
        const requestOptions = options.fetch ? { fetch: options.fetch } : {};
        const user = await fetchGitHubUser(tokens.accessToken, requestOptions);
        const installations = await fetchGitHubInstallations(tokens.accessToken, requestOptions);
        const refresh = await encryptSecret(tokens.refreshToken, options.encryptionKey);
        const access = await encryptSecret(tokens.accessToken, options.encryptionKey);
        await sql.transaction(async (tx) => {
          await tx.query("select id from auth.users where id = $1::uuid for update", [flow.user_id]);
          // Lock/claim the live flow before saving: disconnect or a replacement flow cannot resurrect a grant.
          const live = await tx.query<{ id: string }>(
            "update public.github_authorizations set status = 'connected' where id = $1 and status = 'processing' and expires_at > $2 returning id",
            [flow.id, now()],
          );
          if (!live.rows.length) throw new Error("Authorization was cancelled.");
          await tx.query(
            `insert into public.github_connections(user_id,github_id,login,name,refresh_token_enc,refresh_expires_at,access_token_enc,access_expires_at,installations)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) on conflict(user_id) do update set github_id=excluded.github_id,login=excluded.login,name=excluded.name,refresh_token_enc=excluded.refresh_token_enc,refresh_expires_at=excluded.refresh_expires_at,access_token_enc=excluded.access_token_enc,access_expires_at=excluded.access_expires_at,installations=excluded.installations,revoked_at=null,connection_epoch=gen_random_uuid(),updated_at=now()`,
            [
              flow.user_id,
              user.id,
              user.login,
              user.name,
              refresh,
              tokens.refreshExpiresAt,
              access,
              tokens.accessExpiresAt,
              JSON.stringify(serializeGitHubInstallations(filterAppInstallations(installations))),
            ],
          );
        });
        console.error(
          JSON.stringify({
            event: "github_connection_replaced",
            caller: "account_callback",
            reason: "oauth_connect",
            ownerId: flow.user_id,
            accessExpiresAt: tokens.accessExpiresAt.toISOString(),
            observedRemainingLifetimeMs: tokens.accessExpiresAt.getTime() - now().getTime(),
            accessTokenCached: true,
          }),
        );
        return callbackResult(true);
      } catch {
        try {
          await sql.query(
            "update public.github_authorizations set status = 'failed' where id = $1 and status = 'processing'",
            [flow.id],
          );
        } catch {
          /* Failure responses never expose database or upstream details. */
        }
        return fail();
      }
    },
  };
}

export const CLI_GITHUB_STATE_PREFIX = "armada_cli_";
const { githubOAuthCallback, githubOAuthRelay } = githubCallbackOperations;
const CALLBACK_BODY_LIMIT = githubOAuthRelay.input.maxBodyBytes;
function callbackResult(ok: boolean): Response {
  return Response.json(
    { ok, status: ok ? "connected" : "failed" },
    {
      status: ok ? 200 : 400,
      headers: { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" },
    },
  );
}

/** Only the relay's two string fields; reject duplicate keys, including JSON-escaped aliases. */
function relayObject(raw: string): Record<string, string> {
  const string = /"(?:[^"\\]|\\.)*"/y;
  let at = 0;
  const skip = () => {
    while (/[ \t\r\n]/.test(raw[at] ?? "!") && at < raw.length) at++;
  };
  const take = () => {
    skip();
    string.lastIndex = at;
    const match = string.exec(raw);
    if (!match) throw new Error("Invalid callback.");
    at = string.lastIndex;
    return JSON.parse(match[0]) as string;
  };
  skip();
  if (raw[at++] !== "{") throw new Error("Invalid callback.");
  const result = Object.create(null) as Record<string, string>;
  for (;;) {
    const key = take();
    if ((key !== "state" && key !== "code") || Object.hasOwn(result, key)) throw new Error("Invalid callback.");
    skip();
    if (raw[at++] !== ":") throw new Error("Invalid callback.");
    result[key] = take();
    skip();
    const next = raw[at++];
    if (next === "}") break;
    if (next !== ",") throw new Error("Invalid callback.");
  }
  skip();
  if (at !== raw.length) throw new Error("Invalid callback.");
  return result;
}

async function callbackInput(request: Request): Promise<{ state: string; code: string }> {
  const url = new URL(request.url);
  let values: Record<string, string>;
  if (request.method === "GET") {
    if (
      [...url.searchParams.keys()].some((key) => key !== "state" && key !== "code") ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("code").length !== 1
    )
      throw new Error("Invalid callback.");
    values = { state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? "" };
  } else if (request.method === "POST") {
    if (url.search || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? ""))
      throw new Error("Invalid callback.");
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > CALLBACK_BODY_LIMIT))
      throw new Error("Invalid callback.");
    if (!request.body) throw new Error("Invalid callback.");
    const reader = request.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let raw = "";
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > CALLBACK_BODY_LIMIT) {
          await reader.cancel();
          throw new Error("Invalid callback.");
        }
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
    } catch {
      try {
        await reader.cancel();
      } catch {
        /* Already cancelled or closed. */
      }
      throw new Error("Invalid callback.");
    } finally {
      reader.releaseLock();
    }
    if (declared !== null && Number(declared) !== size) throw new Error("Invalid callback.");
    values = relayObject(raw);
  } else throw new Error("Invalid callback.");
  const schema = request.method === "GET" ? githubOAuthCallback.input.query : githubOAuthRelay.input.body;
  return schema.parse(values);
}

function githubAccountCommand({ route, caller, body, options, request }: ControlRouteContext) {
  if (!options.githubAccount) throw new VaultError("unavailable", "GitHub account authorization is not configured.");
  return options.githubAccount.command(route.slice("github/".length), caller, body, request?.signal);
}

export const githubAccountRoutes = defineRoutes("github-account", {
  "github/status": githubAccountCommand,
  "github/disconnect": githubAccountCommand,
  "github/install": githubAccountCommand,
  "github/connect": githubAccountCommand,
  "github/reconnect": githubAccountCommand,
  [controlRouteKey(githubReposOperation.route)]: githubAccountCommand,
  [controlRouteKey(githubOAuthCallback.route)]: {
    methods: [githubOAuthCallback.route.method, githubOAuthRelay.route.method],
    respond: (request: Request, options: ControlOptions) =>
      options.githubAccount
        ? options.githubAccount.callback(request)
        : fail(503, "dependency_unavailable", "GitHub account authorization is not configured."),
  },
});
