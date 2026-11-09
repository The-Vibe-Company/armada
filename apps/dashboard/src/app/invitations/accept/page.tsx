import type { Metadata } from "next";
import { cookies } from "next/headers";
import { acceptInvitation } from "@/app/actions/invitations";
import { AcceptInvitation } from "@/components/invitations";
import { ControlError, createInvitationControl } from "@/lib/control";
import { readViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import {
  DISCARD_LINK_CREDENTIALS_SCRIPT,
  INVITATION_COOKIE,
  isInvitationToken,
  type RecipientState,
  refusalMessage,
} from "@/lib/invitations";

export const metadata: Metadata = { title: "Invitation", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

/**
 * Where an invitation email leads (#641). The proxy has moved the link's token into an HTTP-only cookie, so this
 * page never sees it in its URL and never prints it; any sign-in credentials the link carried are discarded unread.
 * Signed out, it offers the ordinary sign-in from this browser, back here. Signed in, it asks the server for the
 * read-only preview (`org/invitations/preview`), which shows the org only to the invited, verified address. Joining is
 * the explicit button; a visit never joins and never changes who is signed in.
 */
export default async function AcceptInvitationPage() {
  const token = (await cookies()).get(INVITATION_COOKIE)?.value;
  const viewer = await readViewer();
  let state: RecipientState;
  if (!isInvitationToken(token)) state = { kind: "missing" };
  else if (!viewer) state = { kind: "sign_in" };
  else state = await preview(token, viewer.token, viewer.email || "this account");
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant that drops link credentials from the URL first. */}
      <script dangerouslySetInnerHTML={{ __html: DISCARD_LINK_CREDENTIALS_SCRIPT }} />
      <AcceptInvitation state={state} accept={acceptInvitation} now={new Date()} />
    </>
  );
}

async function preview(token: string, bearer: string | null, signedInAs: string): Promise<RecipientState> {
  const serverUrl = mcpUrl();
  if (!serverUrl || !bearer)
    return {
      kind: "unavailable",
      message: "The Armada server is not configured for this dashboard.",
      signInAgain: false,
    };
  try {
    return {
      kind: "preview",
      preview: await createInvitationControl({ serverUrl, token: bearer }).preview(token),
      signedInAs,
    };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return {
      kind: "unavailable",
      message: refusalMessage(error.reason, error.status, error.retryAfterSeconds),
      signInAgain: error.status === 401,
    };
  }
}
