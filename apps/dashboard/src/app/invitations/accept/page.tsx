import type { Metadata } from "next";
import { cookies } from "next/headers";
import { adoptVerifiedLink, discardVerifiedLink, verifyEmailLink } from "@/app/actions/invitation-signin";
import { acceptInvitation } from "@/app/actions/invitations";
import { EmailLinkBridge, STRIP_EMAIL_LINK_SCRIPT } from "@/components/invitation-link";
import { AcceptInvitation } from "@/components/invitations";
import { ControlError, createInvitationControl } from "@/lib/control";
import { candidate, isFailure, pendingLinkSession } from "@/lib/data/invitation-signin";
import { readViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import {
  decodeEmailLink,
  INVITATION_COOKIE,
  INVITATION_LINK_COOKIE,
  isInvitationToken,
  type RecipientState,
  refusalMessage,
} from "@/lib/invitations";

export const metadata: Metadata = { title: "Invitation", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

/**
 * Where an invitation email leads (#641). The proxy has moved the link's token into an HTTP-only cookie, so this
 * page never sees it in its URL and never prints it. Signed in, it asks the server for the read-only preview
 * (`org/invitations/preview`); the server shows the org only to the invited, verified address. Signing in with the
 * email's own link is an explicit step (the bridge, or `link_sign_in`); joining is another. A visit does neither.
 */
export default async function AcceptInvitationPage() {
  const jar = await cookies();
  const token = jar.get(INVITATION_COOKIE)?.value;
  const viewer = await readViewer();
  let state: RecipientState;
  if (!isInvitationToken(token)) state = { kind: "missing" };
  else if (!viewer) state = await signedOut(jar.get(INVITATION_LINK_COOKIE)?.value);
  else state = await preview(token, viewer.token, viewer.email || "this account");
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant, removing credentials from the URL first. */}
      <script dangerouslySetInnerHTML={{ __html: STRIP_EMAIL_LINK_SCRIPT }} />
      <EmailLinkBridge>
        <AcceptInvitation state={state} accept={acceptInvitation} link={LINK_ACTIONS} now={new Date()} />
      </EmailLinkBridge>
    </>
  );
}

const LINK_ACTIONS = { verify: verifyEmailLink, adopt: adoptVerifiedLink, discard: discardVerifiedLink };

/** Signed out: a verified link waiting for the typed address, a `token_hash` link to check, or the plain sign-in. */
async function signedOut(link: string | undefined): Promise<RecipientState> {
  const pending = await pendingLinkSession();
  if (pending) {
    const found = await candidate(pending.accessToken);
    if (!isFailure(found)) return { kind: "link_confirm" };
  }
  return decodeEmailLink(link) ? { kind: "link_sign_in" } : { kind: "sign_in" };
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
