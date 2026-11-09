import type { Metadata } from "next";
import { cookies } from "next/headers";
import { acceptInvitation } from "@/app/actions/invitations";
import { AcceptInvitation } from "@/components/invitations";
import { ControlError, createInvitationControl } from "@/lib/control";
import { readViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { INVITATION_COOKIE, isInvitationToken, type RecipientState, refusalMessage } from "@/lib/invitations";

export const metadata: Metadata = { title: "Invitation", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

/**
 * Where an invitation email leads (#641). The proxy has moved the link's token into an HTTP-only cookie, so this
 * page never sees it in its URL and never prints it. Signed in, it asks the server for the read-only preview
 * (`org/invitations/preview`); the server shows the org only to the invited, verified address. A visit only
 * explains: the button is the one way to join.
 */
export default async function AcceptInvitationPage() {
  const token = (await cookies()).get(INVITATION_COOKIE)?.value;
  const viewer = await readViewer();
  let state: RecipientState;
  if (!isInvitationToken(token)) state = { kind: "missing" };
  else if (!viewer) state = { kind: "sign_in" };
  else state = await preview(token, viewer.token, viewer.email || "this account");
  return <AcceptInvitation state={state} accept={acceptInvitation} now={new Date()} />;
}

async function preview(token: string, bearer: string | null, signedInAs: string): Promise<RecipientState> {
  const serverUrl = mcpUrl();
  if (!serverUrl || !bearer)
    return { kind: "unavailable", message: "The Armada server is not configured for this dashboard." };
  try {
    return {
      kind: "preview",
      preview: await createInvitationControl({ serverUrl, token: bearer }).preview(token),
      signedInAs,
    };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return { kind: "unavailable", message: refusalMessage(error.reason, error.status, error.retryAfterSeconds) };
  }
}
