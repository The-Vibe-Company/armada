"use server";

import { createClient as createAuthClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { type ActionResult, done, fail } from "@/lib/action";
import { ControlError, createInvitationControl } from "@/lib/control";
import { readViewer } from "@/lib/data/viewer";
import { mcpUrl, supabaseEnv } from "@/lib/env";
import {
  decodeEmailLink,
  INVITATION_ACCEPT_PATH,
  INVITATION_COOKIE,
  INVITATION_LINK_COOKIE,
  isInvitationToken,
  parseEmailLinkFragment,
  type RecipientPreview,
  refusalMessage,
} from "@/lib/invitations";
import { createClient } from "@/lib/supabase/server";

/**
 * Signing in with the invitation email's own link (#641). Only for this page: the link must come with the invitation
 * token already in its cookie, and the identity it carries must be one GoTrue vouches for (a server call, never a
 * decoded JWT), with a verified email the invitation was sent to (the server's preview). Nothing is adopted until the
 * person chooses it, and a different signed-in account is replaced only by that explicit choice. Joining stays a
 * separate, later click. Tokens are arguments and cookie values only: never logged, returned or rendered.
 */

const EXPIRED = "This sign-in link has expired or was already used. Sign in with your email address instead.";
const INVALID = "This sign-in link could not be verified. Sign in with your email address instead.";

/** GoTrue without cookies: it checks or mints a session for us, and stores nothing in this browser. */
function authClient() {
  const { url, anonKey } = supabaseEnv();
  return createAuthClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

type Candidate = { id: string; email: string; preview: RecipientPreview };

/**
 * The account an access token belongs to, as GoTrue answers for it, with a verified email that the invitation in this
 * browser was sent to. The preview is the server's binding check: it names the org only for the invited address.
 */
async function candidate(accessToken: string): Promise<Candidate | ActionResult> {
  const token = (await cookies()).get(INVITATION_COOKIE)?.value;
  if (!isInvitationToken(token)) return fail("Open the invitation link from the email again in this browser.");
  const { data, error } = await authClient().auth.getUser(accessToken);
  const user = data.user;
  if (error || !user?.email) return fail(INVALID);
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
  return { id: user.id, email: user.email, preview };
}

const isResult = (value: Candidate | ActionResult): value is ActionResult => "ok" in value;

export type EmailLinkCheck =
  | { ok: true; email: string; orgName: string; currentEmail: string | null }
  | { ok: false; error: string };

/** Who the fragment's session signs in as, and for which org, before anything is stored. */
export async function inspectEmailLink(hash: string): Promise<EmailLinkCheck> {
  const fragment = parseEmailLinkFragment(hash);
  if (!fragment) return { ok: false, error: INVALID };
  if (fragment.kind === "error") return { ok: false, error: fragment.expired ? EXPIRED : INVALID };
  const found = await candidate(fragment.accessToken);
  if (isResult(found)) return found.ok ? { ok: false, error: INVALID } : found;
  const viewer = await readViewer();
  return {
    ok: true,
    email: found.email,
    orgName: found.preview.context?.orgName ?? "",
    currentEmail: viewer && viewer.id !== found.id ? viewer.email || "another account" : null,
  };
}

/**
 * The explicit "continue as …" of the fragment's session. Everything is checked again, then the refresh token is
 * exchanged at GoTrue: the session stored is the one GoTrue mints for that refresh token, and it must belong to the
 * same account as the access token, so a mismatched pair cannot sign in as one person and refresh into another.
 */
export async function adoptEmailLink(hash: string): Promise<ActionResult> {
  const fragment = parseEmailLinkFragment(hash);
  if (fragment?.kind !== "session") return fail(INVALID);
  const found = await candidate(fragment.accessToken);
  if (isResult(found)) return found;
  const { data, error } = await authClient().auth.refreshSession({ refresh_token: fragment.refreshToken });
  if (error || !data.session || data.user?.id !== found.id) return fail(INVALID);
  return store(data.session.access_token, data.session.refresh_token, found.id);
}

/** The explicit "continue" of a `token_hash` link: verified once, at GoTrue, then bound like a fragment session. */
export async function confirmEmailLink(_previous: ActionResult | null, _data: FormData): Promise<ActionResult> {
  const jar = await cookies();
  const link = decodeEmailLink(jar.get(INVITATION_LINK_COOKIE)?.value);
  if (!link) return fail(EXPIRED);
  const { data, error } = await authClient().auth.verifyOtp({ token_hash: link.tokenHash, type: link.type });
  // A failure keeps the (now spent) cookie until it expires: changing it here would re-render away this answer.
  if (error || !data.session) return fail(EXPIRED);
  const found = await candidate(data.session.access_token);
  if (isResult(found)) return found;
  if (data.user?.id !== found.id) return fail(INVALID);
  const stored = await store(data.session.access_token, data.session.refresh_token, found.id);
  if (stored.ok) jar.delete(INVITATION_LINK_COOKIE);
  return stored;
}

async function store(accessToken: string, refreshToken: string, id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  if (error || data.user?.id !== id) return fail(INVALID);
  revalidatePath(INVITATION_ACCEPT_PATH);
  return done("Signed in.");
}
