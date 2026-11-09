import { describe, expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import { createInvitationControl } from "../src/lib/control.ts";
import {
  acceptFailure,
  deliveryLabel,
  deliveryOutcome,
  expiryLabel,
  INVITATION_COOKIE,
  normalizeInviteEmail,
  parseInvitation,
  pendingInvitations,
  recipientState,
} from "../src/lib/invitations.ts";
import { safeNextPath } from "../src/lib/routes.ts";
import { proxy } from "../src/proxy.ts";

const ORG = "00000000-0000-4000-8000-000000000010";
const now = new Date("2026-11-09T12:00:00Z");
const TOKEN = "tok_0123456789abcdefghijklmnop";

const dto = (patch: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-000000000060",
  orgId: ORG,
  email: "carol@example.com",
  role: "member",
  expiresAt: "2026-11-12T12:00:00Z",
  status: "pending",
  delivery: "sent",
  ...patch,
});

describe("invitation presentation", () => {
  test("only one full email address is invited, trimmed and lowercased", () => {
    expect(normalizeInviteEmail("  Carol@Example.COM ")).toBe("carol@example.com");
    for (const bad of ["carol", "carol@corp", "carol@example.c", "a b@example.com", "a@b.com,c@d.com", ""])
      expect(normalizeInviteEmail(bad)).toBeNull();
  });

  test("the list keeps this org's live pending invitations, soonest to expire first", () => {
    const rows = pendingInvitations(
      [
        dto({ id: "late", expiresAt: "2026-11-15T12:00:00Z" }),
        dto({ id: "soon" }),
        dto({ id: "other-org", orgId: "00000000-0000-4000-8000-000000000011" }),
        dto({ id: "accepted", status: "accepted" }),
        dto({ id: "revoked", status: "revoked" }),
        dto({ id: "expired", expiresAt: "2026-11-09T11:00:00Z" }),
        dto({ id: "bad-delivery", delivery: "delivered" }),
      ],
      ORG,
      now,
    );
    expect(rows?.map((row) => row.id)).toEqual(["soon", "late"]);
    expect(pendingInvitations({}, ORG, now)).toBeNull();
    // Fields the contract does not name never reach the page.
    expect(parseInvitation(dto({ token: "leaked" }))).not.toHaveProperty("token");
  });

  test("an email is reported sent only when the mail service accepted it, never as delivered", () => {
    const invitation = (delivery: string) =>
      parseInvitation(dto({ delivery })) as NonNullable<ReturnType<typeof parseInvitation>>;
    expect(deliveryOutcome(invitation("sent"), "Invited")).toEqual({
      ok: true,
      message: "Invitation emailed to carol@example.com.",
    });
    expect(deliveryLabel("sent").hint).toContain("not confirmed");
    expect(deliveryOutcome(invitation("pending"), "Invited").ok).toBe(true);
    for (const delivery of ["failed", "not_configured"]) {
      expect(deliveryOutcome(invitation(delivery), "Resent").ok).toBe(false);
      expect(deliveryLabel(invitation(delivery).delivery).label).not.toBe("Sent");
    }
  });

  test("expiry is coarse", () => {
    expect(expiryLabel("2026-11-12T12:00:00Z", now)).toBe("Expires in 3 days");
    expect(expiryLabel("2026-11-10T13:00:00Z", now)).toBe("Expires tomorrow");
    expect(expiryLabel("2026-11-09T20:00:00Z", now)).toBe("Expires today");
    expect(expiryLabel("2026-11-09T11:00:00Z", now)).toBe("Expired");
  });

  test("a refused acceptance says what to do next", () => {
    expect(acceptFailure(403, "x").kind).toBe("wrong_account");
    expect(acceptFailure(404, "x").message).toContain("resend");
    expect(acceptFailure(409, "You are already a member of Acme.").message).toBe("You are already a member of Acme.");
    expect(acceptFailure(undefined, "secret detail").message).not.toContain("secret");
  });

  test("the page offers to join only with the link's cookie and a session", () => {
    expect(recipientState(false, "carol@example.com").kind).toBe("missing");
    expect(recipientState(true, null).kind).toBe("sign_in");
    expect(recipientState(true, "carol@example.com")).toEqual({ kind: "ready", signedInAs: "carol@example.com" });
  });
});

describe("invitation link", () => {
  const request = (path: string) => {
    const nextUrl = new URL(`https://dashboard.test${path}`);
    Object.assign(nextUrl, { clone: () => new URL(nextUrl) });
    return { method: "GET", nextUrl, headers: new Headers(), cookies: { getAll: () => [] } } as unknown as NextRequest;
  };

  test("the emailed token moves into an HTTP-only cookie and leaves the URL", async () => {
    const response = await proxy(request(`/invitations/accept?token=${TOKEN}&utm_source=mail`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://dashboard.test/invitations/accept");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${INVITATION_COOKIE}=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/(;|$)/i);
    expect(cookie).toMatch(/Secure/i);
  });

  test("a malformed token is dropped, not stored", async () => {
    const response = await proxy(request("/invitations/accept?token=%3Bpath%3D%2F"));
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("signing in returns to the invitation, never with a token in `next`", () => {
    expect(safeNextPath(`/invitations/accept?token=${TOKEN}`)).toBe("/invitations/accept");
    expect(safeNextPath("/invitations/accept")).toBe("/invitations/accept");
  });
});

describe("invitation control client", () => {
  test("each operation posts its v1 route with the viewer's bearer; the token travels only in the body", async () => {
    const calls: { url: string; auth: string; body: Record<string, unknown> }[] = [];
    const control = createInvitationControl({
      serverUrl: "https://armada.example/mcp",
      token: "user-jwt",
      fetch: (async (url: URL | string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({
          url: String(url),
          auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? "",
          body,
        });
        const route = String(url).split("/api/v1/")[1];
        if (route === "org/invitations/list") return Response.json({ invitations: [dto()] });
        if (route === "org/invitations/accept") return Response.json({ orgId: ORG, accepted: true });
        return Response.json({ invitation: dto() });
      }) as typeof fetch,
    });
    await control.create({ org: ORG, email: "carol@example.com", role: "member" });
    await control.list(ORG);
    await control.resend({ org: ORG, id: "i" });
    await control.revoke({ org: ORG, id: "i" });
    expect(await control.accept(TOKEN)).toEqual({ orgId: ORG });
    expect(calls.map((call) => call.url.replace("https://armada.example/api/v1/", ""))).toEqual([
      "org/invitations/create",
      "org/invitations/list",
      "org/invitations/resend",
      "org/invitations/revoke",
      "org/invitations/accept",
    ]);
    expect(calls.every((call) => call.auth === "Bearer user-jwt" && !call.url.includes(TOKEN))).toBe(true);
    expect(calls[4]?.body).toEqual({ token: TOKEN });
  });

  test("an answer that is not an invitation, or an unconfirmed accept, is an error, never a success", async () => {
    const control = createInvitationControl({
      serverUrl: "https://armada.example",
      token: "user-jwt",
      fetch: (async () => Response.json({ invitation: { id: "x" }, accepted: false })) as unknown as typeof fetch,
    });
    await expect(control.create({ org: ORG, email: "a@b.co", role: "member" })).rejects.toThrow(
      "unexpected invitation",
    );
    await expect(control.accept(TOKEN)).rejects.toThrow("did not confirm");
  });
});
