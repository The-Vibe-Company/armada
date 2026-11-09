"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { ControlError, createInvitationControl } from "@/lib/control";
import { isSelectedOrganization, SELECTED_ORG_COOKIE } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import {
  deliveryOutcome,
  INVITATION_COOKIE,
  isInvitationToken,
  isInviteRole,
  normalizeInviteEmail,
  refusalMessage,
} from "@/lib/invitations";

const NOT_CONFIGURED = "The Armada server is not configured for this dashboard.";

async function control() {
  const viewer = await requireViewer();
  const serverUrl = mcpUrl();
  return serverUrl && viewer.token ? createInvitationControl({ serverUrl, token: viewer.token }) : null;
}

/** The org of an admin form, once it is the organization the person is looking at. */
async function orgOf(data: FormData): Promise<string | ActionResult> {
  const org = formString(data, "org");
  if (!isUuid(org)) return fail("That request is not valid.");
  if (!(await isSelectedOrganization(org))) return fail("Switch to that organization first.");
  return org;
}

const reported = (error: unknown): ActionResult => {
  if (error instanceof ControlError) return fail(error.message);
  throw error;
};

export async function inviteMember(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const org = await orgOf(data);
  if (typeof org !== "string") return org;
  const email = normalizeInviteEmail(formString(data, "email"));
  if (!email) return fail("Enter one full email address, like teammate@company.com.");
  const role = formString(data, "role");
  if (!isInviteRole(role)) return fail("That request is not valid.");
  const client = await control();
  if (!client) return fail(NOT_CONFIGURED);
  try {
    const invitation = await client.create({ org, email, role });
    revalidatePath(`/orgs/${org}`);
    return deliveryOutcome(invitation, "Invited");
  } catch (error) {
    return reported(error);
  }
}

export async function resendInvitation(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const org = await orgOf(data);
  if (typeof org !== "string") return org;
  const id = formString(data, "invitation");
  if (!isUuid(id)) return fail("That request is not valid.");
  const client = await control();
  if (!client) return fail(NOT_CONFIGURED);
  try {
    const invitation = await client.resend({ org, id });
    revalidatePath(`/orgs/${org}`);
    return deliveryOutcome(invitation, "Resent");
  } catch (error) {
    return reported(error);
  }
}

export async function revokeInvitation(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const org = await orgOf(data);
  if (typeof org !== "string") return org;
  const id = formString(data, "invitation");
  if (!isUuid(id)) return fail("That request is not valid.");
  const client = await control();
  if (!client) return fail(NOT_CONFIGURED);
  try {
    const invitation = await client.revoke({ org, id });
    revalidatePath(`/orgs/${org}`);
    return invitation.status === "revoked"
      ? done(`Invitation to ${invitation.email} revoked. Its link no longer works.`)
      : fail("The Armada server did not revoke the invitation.");
  } catch (error) {
    return reported(error);
  }
}

/**
 * The explicit join, from the acceptance page's button. The token comes from its HTTP-only cookie, never from the
 * form. On success the cookie is cleared, the joined org becomes the selected one and the person lands on it.
 */
export async function acceptInvitation(_previous: ActionResult | null, _data: FormData): Promise<ActionResult> {
  const jar = await cookies();
  const token = jar.get(INVITATION_COOKIE)?.value;
  if (!isInvitationToken(token)) return fail("Open the invitation link from the email again in this browser.");
  const client = await control();
  if (!client) return fail(NOT_CONFIGURED);
  let orgId: string;
  try {
    ({ orgId } = await client.accept(token));
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    // The cookie stays (it expires on its own): changing it here would re-render the page and lose this answer.
    return fail(refusalMessage(error.reason, error.status, error.retryAfterSeconds));
  }
  jar.delete(INVITATION_COOKIE);
  if (isUuid(orgId)) {
    jar.set(SELECTED_ORG_COOKIE, orgId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  revalidatePath("/", "layout");
  redirect(isUuid(orgId) ? `/orgs/${orgId}?joined=1` : "/orgs");
}
