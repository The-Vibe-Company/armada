import { createHmac, timingSafeEqual } from "node:crypto";
import { readBoundedText } from "@armada/auth";
import { decryptSecret, encryptSecret, type GoldenActor, type Sql, VaultError } from "@armada/core/server";
import { type NativeState, nativeState } from "./model-auth-state.ts";

const PATH = "/api/internal/model/access";
const READY = "server:ready";
export interface SubscriptionConfiguration {
  url: string;
  capability: string;
}
interface Claims {
  sandboxId: string;
  accountId: string;
  version: number;
  userId: string;
  orgId: string;
}
export interface SubscriptionAccess {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: null;
  revision: number;
}
/** Logical sandbox expiry/revocation is checked in SQL on every request; capability bytes are stable for redaction.
 * Refresh tokens remain sealed on the server. Guest grants authorize access-only material for one current pin. */
export function createSubscriptionBroker(
  sql: Sql,
  key: string | undefined,
  origin: string,
  fetcher: typeof fetch = fetch,
) {
  if (Buffer.from(key ?? "", "base64").length !== 32)
    throw new VaultError("unavailable", "Subscription renewal requires an encryption key.");
  const signing = createHmac("sha256", Buffer.from(key ?? "", "base64"))
    .update("armada/model/access/v1")
    .digest();
  const pending = new Map<string, Promise<SubscriptionAccess>>();
  const sign = (body: string) => createHmac("sha256", signing).update(body).digest("base64url");
  async function account(tx: Sql, actor: GoldenActor, id: string, version: number) {
    const found = await tx.query<{ value_enc: Uint8Array }>(
      `select c.value_enc from public.credentials c
      where c.id=$1::uuid and c.version=$2 and c.kind='codex_auth' and c.status='active'
      and (c.expires_at is null or c.expires_at>now())
      and ((c.scope='user' and c.owner_id=$3::uuid) or (c.scope='org' and c.owner_id=$4::uuid))
      and exists(select 1 from public.members where user_id=$3::uuid and org_id=$4::uuid) for update of c`,
      [id, version, actor.userId, actor.orgId],
    );
    if (!found.rows[0]) throw new VaultError("credential_refused", "The subscription account is no longer authorized.");
    return found.rows[0].value_enc;
  }
  async function enrolled(id: string, version: number) {
    return (
      (
        await sql.query(
          "select 1 from public.model_auth_state where account_id=$1::uuid and account_version=$2 and source_generation like 'server:%'",
          [id, version],
        )
      ).rows.length > 0
    );
  }
  async function saved(tx: Sql, id: string, version: number) {
    const row = (
      await tx.query<{ state_enc: Uint8Array; auth_revision: number; source_generation: string }>(
        "select state_enc,auth_revision,source_generation from public.model_auth_state where account_id=$1::uuid and account_version=$2 for update",
        [id, version],
      )
    ).rows[0];
    if (!row || !row.source_generation.startsWith("server:"))
      throw new VaultError("credential_binding_required", "Shared subscription authentication state is unavailable.");
    return { ...row, state: JSON.parse(await decryptSecret(new Uint8Array(row.state_enc), key)) as NativeState };
  }
  const output = (state: NativeState, revision: number): SubscriptionAccess => {
    const tokens = JSON.parse(state.authJson).tokens;
    return { accessToken: tokens.access_token, chatgptAccountId: tokens.account_id, chatgptPlanType: null, revision };
  };
  async function access(
    actor: GoldenActor,
    id: string,
    version: number,
    previousRevision?: number,
  ): Promise<SubscriptionAccess> {
    const identity = `${id}:${version}`;
    // Authorization is never inherited from another caller's in-flight refresh.
    await sql.transaction!(async (tx) => {
      await account(tx, actor, id, version);
    });
    const existing = pending.get(identity);
    if (existing) {
      const result = await existing;
      // An overlapping ordinary read is not a renewal receipt. If this caller
      // rejected that same revision, admit its refresh after the read settles.
      if (previousRevision === result.revision) {
        if (pending.get(identity) === existing) pending.delete(identity);
        return access(actor, id, version, previousRevision);
      }
      return result;
    }
    const work = (async () => {
      // Another server replica may own the durable refresh intent. Wait only for
      // its publication; NEVER retry its upstream refresh request.
      const deadline = Date.now() + 25_000;
      let selected: { row: Awaited<ReturnType<typeof saved>>; refresh: boolean; waiting?: boolean };
      for (;;) {
        selected = await sql.transaction!(async (tx) => {
          await account(tx, actor, id, version);
          const row = await saved(tx, id, version);
          if (row.source_generation !== READY) return { row, refresh: false, waiting: true };
          const token = output(row.state, row.auth_revision);
          let expiry = 0;
          try {
            expiry = JSON.parse(Buffer.from(token.accessToken.split(".")[1] ?? "", "base64url").toString()).exp * 1000;
          } catch {
            /* Native imported access material may be opaque. */
          }
          const refresh = previousRevision === row.auth_revision || (expiry > 0 && expiry < Date.now() + 60_000);
          if (!refresh) return { row, refresh: false };
          // Commit intent BEFORE contacting the rotating upstream. A crash/unknown reply must never replay it.
          await tx.query(
            "update public.model_auth_state set source_generation='server:refreshing' where account_id=$1::uuid and account_version=$2 and auth_revision=$3",
            [id, version, row.auth_revision],
          );
          return { row, refresh: true };
        });
        if (!selected.waiting) break;
        if (selected.row.source_generation !== "server:refreshing" || Date.now() >= deadline)
          throw new VaultError(
            "unavailable",
            "Subscription renewal is pending or uncertain. Reconnect if it persists.",
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!selected.refresh) return output(selected.row.state, selected.row.auth_revision);
      try {
        const tokens = JSON.parse(selected.row.state.authJson);
        // Native Codex refresh protocol: openai/codex rust-v0.116.0 core/src/auth.rs, request_chatgpt_token_refresh.
        const response = await fetcher("https://auth.openai.com/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
            grant_type: "refresh_token",
            refresh_token: tokens.tokens.refresh_token,
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw Error("refresh_refused");
        const raw = await response.text();
        if (Buffer.byteLength(raw) > 65536) throw Error("refresh_oversized");
        const replacement = JSON.parse(raw);
        if (typeof replacement.access_token !== "string" || !replacement.access_token) throw Error("refresh_invalid");
        tokens.tokens.access_token = replacement.access_token;
        if (typeof replacement.refresh_token === "string" && replacement.refresh_token)
          tokens.tokens.refresh_token = replacement.refresh_token;
        if (typeof replacement.id_token === "string") tokens.tokens.id_token = replacement.id_token;
        const next = nativeState(JSON.stringify(tokens));
        next.secrets = [...new Set([...selected.row.state.secrets, ...next.secrets])];
        return await sql.transaction!(async (tx) => {
          await account(tx, actor, id, version);
          const updated = await tx.query(
            "update public.model_auth_state set state_enc=$4::bytea,auth_revision=auth_revision+1,source_generation=$5,updated_at=now() where account_id=$1::uuid and account_version=$2 and auth_revision=$3 and source_generation='server:refreshing' returning auth_revision",
            [id, version, selected.row.auth_revision, await encryptSecret(JSON.stringify(next), key), READY],
          );
          if (!updated.rows.length) throw Error("refresh_conflict");
          return output(next, selected.row.auth_revision + 1);
        });
      } catch {
        await sql
          .query(
            "update public.model_auth_state set source_generation='server:uncertain' where account_id=$1::uuid and account_version=$2 and auth_revision=$3 and source_generation='server:refreshing'",
            [id, version, selected.row.auth_revision],
          )
          .catch(() => {});
        // Fixed text only; vendor errors and response bodies may contain private material.
        throw new VaultError(
          "unavailable",
          "Subscription renewal could not be confirmed. Reconnect this account before retrying renewal.",
        );
      }
    })();
    pending.set(identity, work);
    try {
      return await work;
    } finally {
      if (pending.get(identity) === work) pending.delete(identity);
    }
  }
  function configuration(
    actor: GoldenActor,
    id: string,
    version: number,
    sandboxId: string,
  ): SubscriptionConfiguration {
    const claims: Claims = { sandboxId, accountId: id, version, userId: actor.userId, orgId: actor.orgId };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return { url: new URL(PATH, origin).href, capability: `${body}.${sign(body)}` };
  }
  return {
    enrolled,
    access,
    async enroll(actor: GoldenActor, id: string, version: number) {
      if (!sql.transaction) throw new VaultError("unavailable", "Subscription renewal requires transactions.");
      await sql.transaction(async (tx) => {
        const raw = await account(tx, actor, id, version);
        // Existing homes and allocation history do not impose account exclusivity.
        // Preserve already-rotated sealed native state when adopting an old account.
        const previous = await tx.query<{ state_enc: Uint8Array; source_generation: string }>(
          "select state_enc,source_generation from public.model_auth_state where account_id=$1::uuid and account_version=$2 for update",
          [id, version],
        );
        const old = previous.rows[0];
        if (!old) {
          const state = nativeState(await decryptSecret(new Uint8Array(raw), key));
          await tx.query(
            "insert into public.model_auth_state(account_id,account_version,state_enc,source_generation) values($1::uuid,$2,$3::bytea,$4)",
            [id, version, await encryptSecret(JSON.stringify(state), key), READY],
          );
        } else if (!old.source_generation.startsWith("server:")) {
          await tx.query(
            "update public.model_auth_state set source_generation=$3,updated_at=now() where account_id=$1::uuid and account_version=$2",
            [id, version, READY],
          );
        }
        await saved(tx, id, version);
      });
    },
    configuration: configuration,
    async secrets(id: string, version: number): Promise<string[]> {
      const state = (await sql.transaction!((tx) => saved(tx, id, version))).state;
      const sandboxes = await sql.query<{ id: string; owner_id: string; org_id: string }>(
        "select id,owner_id,org_id from public.sandboxes where credential_id=$1::uuid and credential_version=$2",
        [id, version],
      );
      return [
        ...state.secrets,
        ...sandboxes.rows.map(
          (s) => configuration({ userId: s.owner_id, orgId: s.org_id, role: "member" }, id, version, s.id).capability,
        ),
      ];
    },
    async route(request: Request): Promise<Response | null> {
      if (new URL(request.url).pathname !== PATH) return null;
      try {
        if (request.method !== "POST" || request.headers.has("origin")) throw Error();
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        if (token.length > 4096) throw Error();
        const [body = "", signature = ""] = token.split(".");
        const expected = sign(body);
        if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
          throw Error();
        const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Claims;
        const current = await sql.query(
          `select 1 from public.sandboxes where id=$1::uuid and credential_id=$2::uuid and credential_version=$3 and owner_id=$4::uuid and org_id=$5::uuid and deleted_at is null and stop_requested_at is null and status in ('starting','ready','running') and (expires_at is null or expires_at>now())`,
          [claims.sandboxId, claims.accountId, claims.version, claims.userId, claims.orgId],
        );
        if (!current.rows.length) throw Error();
        const raw = await readBoundedText(request, 1024);
        const input = JSON.parse(raw) as { previousRevision?: number };
        if (
          input.previousRevision !== undefined &&
          (!Number.isSafeInteger(input.previousRevision) || input.previousRevision < 0)
        )
          throw Error();
        const result = await access(
          { userId: claims.userId, orgId: claims.orgId, role: "member" },
          claims.accountId,
          claims.version,
          input.previousRevision,
        );
        await sql.transaction!(async (tx) => {
          await account(
            tx,
            { userId: claims.userId, orgId: claims.orgId, role: "member" },
            claims.accountId,
            claims.version,
          );
        });
        const final = await sql.query(
          `select 1 from public.sandboxes where id=$1::uuid and credential_id=$2::uuid and credential_version=$3 and owner_id=$4::uuid and org_id=$5::uuid and deleted_at is null and stop_requested_at is null and status in ('starting','ready','running') and (expires_at is null or expires_at>now())`,
          [claims.sandboxId, claims.accountId, claims.version, claims.userId, claims.orgId],
        );
        if (!final.rows.length) throw Error();
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      } catch {
        return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
      }
    },
  };
}
