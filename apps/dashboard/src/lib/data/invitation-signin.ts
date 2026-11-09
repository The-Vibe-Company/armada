import { createClient as createAuthClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { type ActionResult, done, fail } from "@/lib/action";
import { ControlError, createInvitationControl } from "@/lib/control";
import { mcpUrl, supabaseEnv } from "@/lib/env";
import {
  INVITATION_COOKIE,
  INVITATION_LINK_SESSION_COOKIE,
  isInvitationToken,
  type RecipientPreview,
  refusalMessage,
} from "@/lib/invitations";
import { createClient } from "@/lib/supabase/server";

/**
 * Signing in with the invitation email's own link (#641), server side. Only for the acceptance page: the link must
 * come with the invitation token already in its cookie, and the identity it carries must be one GoTrue vouches for (a
 * server call, never a decoded JWT), with a verified email the invitation was sent to (the server's preview). A
 * session is stored only on the person's explicit "continue as …", and joining stays a separate, later click. Tokens
 * are arguments and cookie values only: never logged, returned or rendered.
 */

export const LINK_EXPIRED =
  "This sign-in link has expired or was already used. Sign in with your email address instead.";
export const LINK_INVALID = "This sign-in link could not be verified. Sign in with your email address instead.";

/** GoTrue without cookies: it checks or mints a session for us, and stores nothing in this browser. */
export function authClient() {
  const { url, anonKey } = supabaseEnv();
  return createAuthClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export type Candidate = { id: string; email: string; orgName: string; preview: RecipientPreview };

export const isFailure = (value: Candidate | ActionResult): value is ActionResult => "ok" in value;

/**
 * The account an access token belongs to, as GoTrue answers for it, with a verified email that the invitation in this
 * browser was sent to. The preview is the server's binding check: it names the org only for the invited address.
 */
export async function candidate(accessToken: string): Promise<Candidate | ActionResult> {
  const token = (await cookies()).get(INVITATION_COOKIE)?.value;
  if (!isInvitationToken(token)) return fail("Open the invitation link from the email again in this browser.");
  const { data, error } = await authClient().auth.getUser(accessToken);
  const user = data.user;
  if (error || !user?.email) return fail(LINK_INVALID);
  if (!user.email_confirmed_at) return fail(refusalMessage("unverified_email", 403));
  const serverUrl = mcpUrl();
  if (!serverUrl) return fail("The Armada server is not configured for this dashboard.");
  let preview: RecipientPreview;
  try {
    preview = await createInvitationControl({ serverUrl, token: accessToken }).preview(token);
  } catch (caught) {
    if (!(caught instanceof ControlError)) throw caught;
    return fail(refusalMessage(caught.reason, caught.status, caught.retryAfterSeconds));
  }
  // Without context the server did not match this address to the invitation: this link is not for it.
  if (preview.context === null) return fail(refusalMessage(preview.state, undefined));
  return { id: user.id, email: user.email, orgName: preview.context.orgName, preview };
}

/**
 * Stores a session after the explicit choice. The refresh token is exchanged at GoTrue first: the session stored is
 * the one GoTrue mints for it, and it must belong to the account the access token was checked for, so a mismatched
 * pair cannot sign in as one person and refresh into another.
 */
export async function adopt(accessToken: string, refreshToken: string): Promise<ActionResult> {
  const found = await candidate(accessToken);
  if (isFailure(found)) return found;
  const { data, error } = await authClient().auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session || data.user?.id !== found.id) return fail(LINK_INVALID);
  const supabase = await createClient();
  const stored = await supabase.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  if (stored.error || stored.data.user?.id !== found.id) return fail(LINK_INVALID);
  return done("Signed in.");
}

/** The session a verified `token_hash` minted, held until the person chooses to continue as its account. */
export async function pendingLinkSession(): Promise<{ accessToken: string; refreshToken: string } | null> {
  const value = (await cookies()).get(INVITATION_LINK_SESSION_COOKIE)?.value;
  if (!value) return null;
  const [accessToken, refreshToken, ...rest] = value.split(" ");
  return accessToken && refreshToken && rest.length === 0 ? { accessToken, refreshToken } : null;
}
