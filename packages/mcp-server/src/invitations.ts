import { createHash, randomBytes } from "node:crypto";
import type { OrganizationInvitation } from "@armada/core";
import { decryptSecret, encryptSecret, type Sql, VaultError } from "@armada/core/server";
import type { Caller, SupabaseProject } from "./caller.ts";

interface Row {
  id: string;
  org_id: string;
  email: string;
  role: "member" | "admin";
  expires_at: string | Date;
  status: OrganizationInvitation["status"];
  delivery: OrganizationInvitation["delivery"];
  token_enc: Uint8Array<ArrayBuffer> | null;
}
const columns = "id,org_id,email,role,expires_at,status,delivery";
const dto = (r: Row): OrganizationInvitation => ({
  id: r.id,
  orgId: r.org_id,
  email: r.email,
  role: r.role,
  expiresAt: new Date(r.expires_at).toISOString(),
  status: r.status,
  delivery: r.delivery,
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export interface InvitationMail {
  send(email: string, token: string): Promise<void>;
}
/** Supabase Auth uses the already configured SMTP; success means provider accepted, not inbox delivery. */
export function supabaseInvitationMail(project: SupabaseProject, origin: string): InvitationMail {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash)
    throw new Error("Invitation origin must be an HTTPS origin.");
  return {
    async send(email, token) {
      const redirect = new URL("/invitations/accept", base);
      redirect.searchParams.set("token", token);
      const url = new URL("/auth/v1/otp", project.supabaseUrl);
      url.searchParams.set("redirect_to", redirect.href);
      const response = await (project.fetch ?? fetch)(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { apikey: project.anonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ email, create_user: true }),
      });
      if (!response.ok) throw new Error("Invitation mail was not accepted.");
    },
  };
}

export class Invitations {
  constructor(
    private sql: Sql,
    private key: string | undefined,
    private mail?: InvitationMail,
    private now: () => Date = () => new Date(),
  ) {}
  private async tx<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
    if (!this.sql.transaction) throw new VaultError("unavailable", "Invitation transactions unavailable.");
    return this.sql.transaction(work);
  }
  async manage(action: string, caller: Caller, org: string, body: Record<string, unknown>) {
    if (!caller.orgs.some((s) => s.orgId === org && s.role === "admin"))
      throw new VaultError("forbidden", "Organization admin required.");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !uuid.test(org) ||
      !["create", "list", "resend", "revoke"].includes(action) ||
      ((action === "resend" || action === "revoke") && (typeof body.id !== "string" || !uuid.test(body.id)))
    )
      throw new VaultError("invalid", "Valid organization and invitation IDs required.");
    const result = await this.tx(async (sql) => {
      // Org row serializes invite/rate checks and acceptance; recheck live admin inside lock.
      await sql.query("select id from public.orgs where id=$1 for update", [org]);
      const admin = await sql.query("select 1 from public.members where org_id=$1 and user_id=$2 and role='admin'", [
        org,
        caller.userId,
      ]);
      if (!admin.rows.length) throw new VaultError("forbidden", "Organization admin required.");
      if (action === "list")
        return {
          invitations: (
            await sql.query<Row>(
              `select ${columns} from public.organization_invitations where org_id=$1 order by created_at desc`,
              [org],
            )
          ).rows.map(dto),
        };
      const now = this.now();
      if (action === "revoke") {
        const r = await sql.query<Row>(
          `update public.organization_invitations set status='revoked',token_enc=null where org_id=$1 and id=$2 and status='pending' returning ${columns}`,
          [org, body.id],
        );
        if (!r.rows[0]) throw new VaultError("not_found", "Pending invitation not found.");
        return { invitation: dto(r.rows[0]) };
      }
      const recent = await sql.query(
        "select 1 from public.organization_invitations where org_id=$1 and updated_at > $2 limit 1",
        [org, new Date(now.getTime() - 60_000)],
      );
      if (recent.rows.length) throw new VaultError("conflict", "Invitation rate limit: retry after one minute.");
      const token = randomBytes(32).toString("base64url");
      const encrypted = this.key && this.mail ? await encryptSecret(token, this.key) : null;
      const expires = new Date(now.getTime() + 7 * 86400_000);
      const delivery = encrypted ? "pending" : "not_configured";
      let rows: Row[];
      if (action === "create") {
        if (
          typeof body.email !== "string" ||
          body.email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
          (body.role !== "member" && body.role !== "admin")
        )
          throw new VaultError("invalid", "Valid email and member/admin role required.");
        const email = body.email.trim().toLowerCase();
        if (
          (
            await sql.query(
              "select 1 from public.members m join auth.users u on u.id=m.user_id where m.org_id=$1 and lower(u.email)=$2",
              [org, email],
            )
          ).rows.length
        )
          throw new VaultError("conflict", "Already an organization member.");
        if (
          (
            await sql.query(
              "select 1 from public.organization_invitations where org_id=$1 and email=$2 and status='pending'",
              [org, email],
            )
          ).rows.length
        )
          throw new VaultError("conflict", "Pending invitation already exists; resend or revoke it.");
        rows = (
          await sql.query<Row>(
            `insert into public.organization_invitations(org_id,email,role,hash,token_enc,expires_at,delivery,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8) returning ${columns}`,
            [org, email, body.role, hash(token), encrypted, expires, delivery, now],
          )
        ).rows;
      } else if (action === "resend") {
        rows = (
          await sql.query<Row>(
            `update public.organization_invitations set hash=$3,token_enc=$4,expires_at=$5,delivery=$6,updated_at=$7,attempts=0,lease_until=null where org_id=$1 and id=$2 and status='pending' returning ${columns}`,
            [org, body.id, hash(token), encrypted, expires, delivery, now],
          )
        ).rows;
      } else throw new VaultError("invalid", "Unknown invitation action.");
      if (!rows[0]) throw new VaultError("not_found", "Pending invitation not found.");
      return { invitation: dto(rows[0]) };
    });
    if ("invitation" in result && result.invitation.delivery === "pending") {
      await this.deliver(result.invitation.id);
      const r = await this.sql.query<Row>(`select ${columns} from public.organization_invitations where id=$1`, [
        result.invitation.id,
      ]);
      return { invitation: dto(r.rows[0]!) };
    }
    return result;
  }
  /** Durable retry entrypoint: bounded batch; leases recover after crash, at-least-once mail. */
  async retry() {
    await this.sql.query(
      "update public.organization_invitations set delivery='failed',lease_until=null,token_enc=null where status='pending' and delivery in ('pending','failed') and ((attempts>=5 and (lease_until is null or lease_until<$1)) or expires_at<=$1)",
      [this.now()],
    );
    const rows = await this.sql.query<{ id: string }>(
      "select id from public.organization_invitations where status='pending' and delivery in ('pending','failed') and attempts<5 and expires_at>$1 and (lease_until is null or lease_until<$1) order by updated_at limit 20",
      [this.now()],
    );
    for (const row of rows.rows) await this.deliver(row.id);
  }
  private async deliver(id: string) {
    if (!this.mail || !this.key) return;
    const now = this.now();
    const r = await this.sql.query<Row & { hash: string }>(
      `update public.organization_invitations set lease_until=$2,attempts=attempts+1 where id=$1 and status='pending' and delivery in ('pending','failed') and attempts<5 and expires_at>$3 and (lease_until is null or lease_until<$3) returning ${columns},token_enc,hash`,
      [id, new Date(now.getTime() + 60_000), now],
    );
    const row = r.rows[0];
    if (!row?.token_enc) return;
    let state = "failed";
    try {
      await this.mail.send(row.email, await decryptSecret(row.token_enc, this.key));
      state = "sent";
    } catch {
      /* Never persist provider errors or tokens. */
    }
    await this.sql.query(
      "update public.organization_invitations set delivery=$3,lease_until=null,token_enc=case when $3='sent' then null else token_enc end where id=$1 and hash=$2 and status='pending'",
      [id, row.hash, state],
    );
  }
  async accept(caller: Caller, token: unknown) {
    if (caller.via !== "supabase") throw new VaultError("forbidden", "Personal verified login required.");
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new VaultError("invalid", "Invalid invitation.");
    return this.tx(async (sql) => {
      const found = await sql.query<Row>(`select ${columns} from public.organization_invitations where hash=$1`, [
        hash(token),
      ]);
      const row = found.rows[0];
      if (!row) throw new VaultError("not_found", "Invitation unavailable.");
      await sql.query("select id from public.orgs where id=$1 for update", [row.org_id]);
      const user = await sql.query(
        "select 1 from auth.users where id=$1 and lower(email)=$2 and email_confirmed_at is not null for update",
        [caller.userId, row.email],
      );
      if (!user.rows.length) throw new VaultError("forbidden", "Sign in with the invitation's verified email.");
      const used = await sql.query(
        "update public.organization_invitations set status='accepted',token_enc=null where id=$1 and hash=$2 and status='pending' and expires_at>$3 returning id",
        [row.id, hash(token), this.now()],
      );
      if (!used.rows.length) throw new VaultError("conflict", "Invitation expired or already used.");
      await sql.query(
        "insert into public.members(org_id,user_id,role) values($1,$2,$3) on conflict(org_id,user_id) do nothing",
        [row.org_id, caller.userId, row.role],
      );
      return { orgId: row.org_id, accepted: true as const };
    });
  }
}

/** Explicit opt-in only. Creating the service never sends email. */
export function invitationsFromEnv(sql: Sql, env: Record<string, string | undefined>): Invitations {
  const mail =
    env.ARMADA_INVITATION_MAIL === "supabase"
      ? supabaseInvitationMail(
          { supabaseUrl: env.SUPABASE_URL!, anonKey: env.SUPABASE_ANON_KEY! },
          env.ARMADA_DASHBOARD_URL!,
        )
      : undefined;
  return new Invitations(sql, env.ARMADA_ENCRYPTION_KEY, mail);
}

/** Opt-in background retries; stop tracks in-flight delivery through shutdown. */
export function startInvitationWorker(service: Invitations) {
  let stopped = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (async () => {
    while (!stopped) {
      try {
        await service.retry();
      } catch {
        /* Durable state is retried; never log mail errors. */
      }
      if (!stopped)
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 60_000);
          timer.unref();
        });
    }
  })();
  return {
    done,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
    },
  };
}
