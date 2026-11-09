import type { Metadata } from "next";
import { cookies } from "next/headers";
import { acceptInvitation } from "@/app/actions/invitations";
import { AcceptInvitation } from "@/components/invitations";
import { readViewer } from "@/lib/data/viewer";
import { INVITATION_COOKIE, isInvitationToken, recipientState } from "@/lib/invitations";

export const metadata: Metadata = { title: "Invitation", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

/**
 * Where an invitation email leads (#641). The proxy has moved the link's token into an HTTP-only cookie, so this
 * page never sees it in its URL and never prints it. A visit only explains; the button is the one way to join.
 */
export default async function AcceptInvitationPage() {
  const token = (await cookies()).get(INVITATION_COOKIE)?.value;
  const viewer = await readViewer();
  return (
    <AcceptInvitation
      state={recipientState(isInvitationToken(token), viewer ? viewer.email || "this account" : null)}
      accept={acceptInvitation}
    />
  );
}
