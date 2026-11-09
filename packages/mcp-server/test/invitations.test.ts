import { expect, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import { createSqlVaultStore, type Sql } from "@armada/core/server";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import type { Caller } from "../src/caller.ts";
import { handleControlRequest } from "../src/control.ts";
import { Invitations, supabaseInvitationMail } from "../src/invitations.ts";

// Authoring gate: real schema owns authorization, CAS, expiry and membership preservation.
// Injectable mail owns only delivery evidence; no mocked database implements these rules.
test("invitation lifecycle persists honest delivery and explicit verified single-use acceptance", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    const admin = "11111111-1111-4111-8111-111111111111",
      recipient = "22222222-2222-4222-8222-222222222222";
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'admin@example.invalid',now()),($2,'new@example.invalid',null)",
      [admin, recipient],
    );
    const org = (await db.query<{ id: string }>("insert into orgs(name) values('Invites') returning id")).rows[0]!.id;
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, admin]);
    const sql: Sql = {
      query: async (q, p) => ({ rows: (await db.query(q, p)).rows as never }),
      transaction: (work) =>
        db.transaction((tx) => work({ query: async (q, p) => ({ rows: (await tx.query(q, p)).rows as never }) })),
    };
    const actor: Caller = { userId: admin, via: "supabase", orgs: [{ orgId: org, role: "admin" }] };
    const user: Caller = { userId: recipient, via: "supabase", orgs: [] };
    let clock = new Date("2030-01-01"),
      token = "",
      sends = 0,
      reject = true;
    const key = Buffer.alloc(32, 7).toString("base64");
    const service = new Invitations(
      sql,
      key,
      {
        async send(_email, t) {
          sends++;
          token = t;
          if (reject) throw new Error("private mail error");
        },
      },
      () => clock,
    );
    const options = {
      invitations: service,
      authStore: createSqlAuthStore(sql),
      store: createSqlVaultStore(sql),
      encryptionKey: key,
      supabase: {
        supabaseUrl: "https://project.supabase.co",
        anonKey: "anon",
        fetch: async () => Response.json({ id: admin }),
      },
    };
    const api = (action: string, body: unknown, method = "POST") =>
      handleControlRequest(
        new Request(`https://api.example.invalid/api/v1/org/invitations/${action}`, {
          method,
          headers: { authorization: "Bearer aa.bb.cc", "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        }),
        options,
      );
    expect((await api("accept", {}, "GET"))?.status).toBe(405);
    expect((await api("resend", { org, id: "broken" }))?.status).toBe(400);
    expect((await api("list", { org }))?.status).toBe(200);
    const created = await service.manage("create", actor, org, { email: "NEW@example.invalid", role: "member" });
    expect(created).toMatchObject({
      invitation: { email: "new@example.invalid", delivery: "failed", status: "pending" },
    });
    expect(JSON.stringify(created)).not.toContain(token);
    expect((await db.query("select 1 from members where user_id=$1", [recipient])).rows).toHaveLength(0);
    await expect(service.accept(user, token)).rejects.toThrow("verified email");
    await db.query("update auth.users set email_confirmed_at=now() where id=$1", [recipient]);
    reject = false;
    await service.retry();
    expect(sends).toBe(2);
    const first = token;
    expect(await service.manage("list", actor, org, {})).toMatchObject({ invitations: [{ delivery: "sent" }] });
    await expect(
      service.manage("resend", actor, org, { id: "invitation" in created ? created.invitation.id : "" }),
    ).rejects.toThrow("rate limit");
    clock = new Date(clock.getTime() + 61_000);
    const id = "invitation" in created ? created.invitation.id : "";
    await service.manage("resend", actor, org, { id });
    await expect(service.accept(user, first)).rejects.toThrow("unavailable");
    await expect(service.manage("list", user, org, {})).rejects.toThrow("admin required");
    await expect(service.accept({ ...user, userId: admin }, token)).rejects.toThrow("verified email");

    const results = await Promise.allSettled([service.accept(user, token), service.accept(user, token)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await db.query<{ role: string }>("select role from members where org_id=$1 and user_id=$2", [org, recipient]))
        .rows[0]?.role,
    ).toBe("member");
    // A separate pending invite races a legacy direct-admin writer; acceptance preserves admin.
    clock = new Date(clock.getTime() + 61_000);
    await service.manage("create", actor, org, { email: "preserve@example.invalid", role: "member" });
    const preserve = "33333333-3333-4333-8333-333333333333";
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'preserve@example.invalid',now())", [
      preserve,
    ]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, preserve]);
    const preserveToken = token;
    await service.accept({ ...user, userId: preserve }, preserveToken);
    expect(
      (await db.query<{ role: string }>("select role from members where org_id=$1 and user_id=$2", [org, preserve]))
        .rows[0]?.role,
    ).toBe("admin");
    await expect(service.accept({ ...user, userId: preserve }, preserveToken)).rejects.toThrow("already used");
    clock = new Date(clock.getTime() + 61_000);
    await expect(
      service.manage("create", actor, org, { email: "new@example.invalid", role: "member" }),
    ).rejects.toThrow("Already");
    const extra = await service.manage("create", actor, org, { email: "other@example.invalid", role: "admin" });
    const extraToken = token;
    if ("invitation" in extra) await service.manage("revoke", actor, org, { id: extra.invitation.id });
    await db.query("update auth.users set email='other@example.invalid' where id=$1", [recipient]);
    await expect(service.accept(user, extraToken)).rejects.toThrow("already used");
    clock = new Date(clock.getTime() + 61_000);
    await service.manage("create", actor, org, { email: "expire@example.invalid", role: "member" });
    const expiredToken = token;
    await db.query("update auth.users set email='expire@example.invalid' where id=$1", [recipient]);
    clock = new Date(clock.getTime() + 8 * 86400_000);
    await expect(service.accept(user, expiredToken)).rejects.toThrow("expired");
    // Simulate crash after the fifth claimed send; recovery must terminate pending state.
    await db.query(
      "update organization_invitations set delivery='pending',attempts=5,lease_until=$1,expires_at=$2 where hash is not null and email='expire@example.invalid'",
      [new Date(clock.getTime() - 1), new Date(clock.getTime() + 86400_000)],
    );
    await service.retry();
    expect(
      (
        await db.query<{ delivery: string }>(
          "select delivery from organization_invitations where email='expire@example.invalid'",
        )
      ).rows[0]?.delivery,
    ).toBe("failed");
    await db.exec("set role authenticated");
    await expect(db.query("select hash,token_enc from organization_invitations")).rejects.toThrow("permission denied");
    await db.exec("reset role");
    clock = new Date(clock.getTime() + 61_000);
    expect(
      await new Invitations(sql, undefined, undefined, () => clock).manage("create", actor, org, {
        email: "offline@example.invalid",
        role: "member",
      }),
    ).toMatchObject({ invitation: { delivery: "not_configured" } });
  } finally {
    await db.close();
  }
});

test("Supabase invitation adapter uses fixed redirect and rejects unsuccessful delivery without leaking response", async () => {
  let request: Request | undefined;
  const project = {
    supabaseUrl: "https://project.supabase.co",
    anonKey: "public-anon",
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      return new Response("private provider error", { status: 429 });
    },
  };
  const mail = supabaseInvitationMail(project, "https://armada.example.invalid");
  await expect(mail.send("fixture@example.invalid", "invitation-token")).rejects.toThrow("not accepted");
  expect(new URL(request!.url).searchParams.get("redirect_to")).toBe(
    "https://armada.example.invalid/invitations/accept?token=invitation-token",
  );
  expect(await request!.json()).toEqual({ email: "fixture@example.invalid", create_user: true });
  expect(() => supabaseInvitationMail(project, "https://example.invalid/evil")).toThrow("HTTPS origin");
});
