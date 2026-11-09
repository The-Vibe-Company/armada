import { describe, expect, test } from "bun:test";
import {
  deliveryLabel,
  expiryLabel,
  type InvitationPreview,
  normalizeInviteEmail,
  recipientState,
} from "../src/lib/invitations.ts";

const now = new Date("2026-11-09T12:00:00Z");
const preview = (patch: Partial<InvitationPreview> = {}): InvitationPreview => ({
  orgName: "Vibe",
  email: "carol@example.com",
  role: "member",
  status: "pending",
  expiresAt: "2026-11-12T12:00:00Z",
  ...patch,
});

describe("invitations", () => {
  test("only one full email address is invited, trimmed and lowercased", () => {
    expect(normalizeInviteEmail("  Carol@Example.COM ")).toBe("carol@example.com");
    for (const bad of ["carol", "carol@corp", "carol@example.c", "a b@example.com", "a@b.com,c@d.com", ""])
      expect(normalizeInviteEmail(bad)).toBeNull();
  });

  test("delivery is never shown as sent before the mail service accepted it", () => {
    expect(deliveryLabel("pending").label).not.toMatch(/sent/i);
    expect(deliveryLabel("failed").label).not.toMatch(/sent/i);
    expect(deliveryLabel("sent").label).toBe("Email sent");
  });

  test("expiry is coarse", () => {
    expect(expiryLabel("2026-11-12T12:00:00Z", now)).toBe("Expires in 3 days");
    expect(expiryLabel("2026-11-10T13:00:00Z", now)).toBe("Expires tomorrow");
    expect(expiryLabel("2026-11-09T20:00:00Z", now)).toBe("Expires today");
    expect(expiryLabel("2026-11-09T11:00:00Z", now)).toBe("Expired");
  });

  test("the accept button is offered only to the invited, verified address on a live invitation", () => {
    const carol = { email: "CAROL@example.com", emailVerified: true };
    expect(recipientState(null, carol, now).kind).toBe("not_found");
    expect(recipientState(preview(), null, now).kind).toBe("sign_in");
    expect(recipientState(preview(), carol, now).kind).toBe("ready");
    expect(recipientState(preview(), { email: "dave@example.com", emailVerified: true }, now)).toMatchObject({
      kind: "wrong_account",
      signedInAs: "dave@example.com",
    });
    expect(recipientState(preview(), { ...carol, emailVerified: false }, now).kind).toBe("unverified");
    expect(recipientState(preview({ status: "revoked" }), carol, now).kind).toBe("revoked");
    expect(recipientState(preview({ status: "accepted" }), carol, now).kind).toBe("accepted");
    // The clock wins over a stale "pending".
    expect(recipientState(preview({ expiresAt: "2026-11-09T11:00:00Z" }), carol, now).kind).toBe("expired");
  });
});
