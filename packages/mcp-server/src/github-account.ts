import {
  createSqlVaultStore,
  encryptSecret,
  exchangeGitHubCode,
  fetchGitHubInstallations,
  fetchGitHubUser,
  GITHUB_AUTHORIZE_URL,
  type GitHubApp,
  resolveGitHubAccess,
  type Sql,
  VaultError,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { dashboardOrigin } from "./config.ts";

export interface GitHubAccountApi {
  command(action: string, caller: Caller, body: Record<string, unknown>): Promise<unknown>;
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
  fetch?: typeof fetch;
  now?: () => Date;
}): GitHubAccountApi {
  const { sql } = options;
  const now = options.now ?? (() => new Date());
  const redirectUri = new URL("/github/callback", dashboardOrigin(options.dashboardUrl, options.development)).href;
  const installUrl =
    options.slug && /^[A-Za-z0-9-]+$/.test(options.slug)
      ? `https://github.com/apps/${options.slug}/installations/new`
      : null;
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
        const live = await fetchGitHubInstallations(access.token, options.fetch ? { fetch: options.fetch } : {});
        installations = live.map((i) => ({
          id: i.id,
          app_id: i.appId,
          app_slug: i.appSlug,
          account: i.accountLogin,
          account_type: i.accountType,
          repository_selection: i.repositorySelection,
        }));
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
    async command(action, caller, body) {
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
      if (action === "disconnect") {
        if (!sql.transaction) throw new VaultError("unavailable", "Transactional account storage is required.");
        await sql.transaction(async (tx) => {
          await tx.query("select id from auth.users where id = $1::uuid for update", [caller.userId]);
          await tx.query("delete from public.github_authorizations where user_id = $1::uuid", [caller.userId]);
          await tx.query("delete from public.github_connections where user_id = $1::uuid", [caller.userId]);
        });
        return { ok: true };
      }
      if (action === "install") {
        if (!installUrl) throw new VaultError("unavailable", "GitHub App installation is not configured.");
        return { authorizationUrl: installUrl };
      }
      if (action === "connect" || action === "reconnect") {
        if (!options.app) throw new VaultError("unavailable", "GitHub App authorization is not configured.");
        const state = CLI_GITHUB_STATE_PREFIX + crypto.randomUUID() + crypto.randomUUID();
        const flowId = crypto.randomUUID();
        if (!sql.transaction) throw new VaultError("unavailable", "Transactional account storage is required.");
        await sql.transaction(async (tx) => {
          await tx.query("select id from auth.users where id = $1::uuid for update", [caller.userId]);
          await tx.query(
            "delete from public.github_authorizations where user_id = $1::uuid and (expires_at < $2 or status in ('pending','processing'))",
            [caller.userId, now()],
          );
          await tx.query(
            "insert into public.github_authorizations(id,user_id,state_hash,status,expires_at) values ($1,$2,$3,'pending',$4)",
            [flowId, caller.userId, await hash(state), new Date(now().getTime() + 600_000)],
          );
        });
        const url = new URL(GITHUB_AUTHORIZE_URL);
        url.searchParams.set("client_id", options.app.clientId);
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
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) on conflict(user_id) do update set github_id=excluded.github_id,login=excluded.login,name=excluded.name,refresh_token_enc=excluded.refresh_token_enc,refresh_expires_at=excluded.refresh_expires_at,access_token_enc=excluded.access_token_enc,access_expires_at=excluded.access_expires_at,installations=excluded.installations,revoked_at=null,updated_at=now()`,
            [
              flow.user_id,
              user.id,
              user.login,
              user.name,
              refresh,
              tokens.refreshExpiresAt,
              access,
              tokens.accessExpiresAt,
              JSON.stringify(
                installations.map((i) => ({
                  id: i.id,
                  app_id: i.appId,
                  app_slug: i.appSlug,
                  account: i.accountLogin,
                  account_type: i.accountType,
                  repository_selection: i.repositorySelection,
                })),
              ),
            ],
          );
        });
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
const CALLBACK_BODY_LIMIT = 8192;
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
  if (!/^armada_cli_[0-9a-f-]{72}$/.test(values.state ?? "") || !/^[\x21-\x7e]{1,1024}$/.test(values.code ?? ""))
    throw new Error("Invalid callback.");
  return { state: values.state ?? "", code: values.code ?? "" };
}
