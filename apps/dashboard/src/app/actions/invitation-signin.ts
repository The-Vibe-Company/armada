"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { type ActionResult, done, fail, formString } from "@/lib/action";
import {
  adopt,
  authClient,
  candidate,
  isFailure,
  LINK_EXPIRED,
  LINK_INVALID,
  pendingLinkSession,
} from "@/lib/data/invitation-signin";
import { readViewer } from "@/lib/data/viewer";
import {
  decodeEmailLink,
  INVITATION_ACCEPT_PATH,
  INVITATION_LINK_COOKIE,
  INVITATION_LINK_MAX_AGE,
  INVITATION_LINK_SESSION_COOKIE,
  parseEmailLinkFragment,
} from "@/lib/invitations";

/** The explicit steps of signing in with the invitation email's own link; see `@/lib/data/invitation-signin`. */

/**
 * What the page may know before the person states their intent: that the link is genuine and for this invitation, and
 * which account (theirs, from their own session) is signed in now. Never the link's address or org: the person must
 * type the address they expect, so a link-controlled lookalike cannot be confirmed with one click.
 */
export type EmailLinkCheck = { ok: true; currentEmail: string | null } | { ok: false; error: string };

/** Whether the fragment's session is a verified account bound to this invitation, before anything is stored. */
export async function inspectEmailLink(hash: string): Promise<EmailLinkCheck> {
  const fragment = parseEmailLinkFragment(hash);
  if (!fragment) return { ok: false, error: LINK_INVALID };
  if (fragment.kind === "error") return { ok: false, error: fragment.expired ? LINK_EXPIRED : LINK_INVALID };
  const found = await candidate(fragment.accessToken);
  if (isFailure(found)) return found.ok ? { ok: false, error: LINK_INVALID } : found;
  const viewer = await readViewer();
  return { ok: true, currentEmail: viewer && viewer.id !== found.id ? viewer.email || "another account" : null };
}

/** The fragment's session, adopted only when the typed address is exactly the link's verified account. */
export async function adoptEmailLink(hash: string, typedEmail: string): Promise<ActionResult> {
  const fragment = parseEmailLinkFragment(hash);
  if (fragment?.kind !== "session") return fail(LINK_INVALID);
  const result = await adopt(fragment.accessToken, fragment.refreshToken, typedEmail);
  if (result.ok) revalidatePath(INVITATION_ACCEPT_PATH);
  return result;
}

/**
 * First step of a `token_hash` link: verify it once at GoTrue and check whose it is. The minted session waits in an
 * HTTP-only cookie scoped to this page; the page then asks for the address and nothing is signed in yet.
 */
export async function verifyEmailLink(_previous: ActionResult | null, _data: FormData): Promise<ActionResult> {
  const jar = await cookies();
  const link = decodeEmailLink(jar.get(INVITATION_LINK_COOKIE)?.value);
  if (!link) return fail(LINK_EXPIRED);
  const { data, error } = await authClient().auth.verifyOtp({ token_hash: link.tokenHash, type: link.type });
  // A failure keeps the (now spent) cookie until it expires: changing it here would re-render away this answer.
  if (error || !data.session) return fail(LINK_EXPIRED);
  const found = await candidate(data.session.access_token);
  if (isFailure(found)) return found;
  if (data.user?.id !== found.id) return fail(LINK_INVALID);
  jar.delete(INVITATION_LINK_COOKIE);
  jar.set(INVITATION_LINK_SESSION_COOKIE, `${data.session.access_token} ${data.session.refresh_token}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: INVITATION_ACCEPT_PATH,
    maxAge: INVITATION_LINK_MAX_AGE,
  });
  return done("Link verified.");
}

/** Second step: the typed address must be exactly the verified link's account. */
export async function adoptVerifiedLink(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const pending = await pendingLinkSession();
  if (!pending) return fail(LINK_EXPIRED);
  // Shown to a signed-out viewer only: if another account signed in since (another tab), it is not replaced here.
  const viewer = await readViewer();
  if (viewer) return fail(`This browser is now signed in as ${viewer.email || "another account"}. Reload the page.`);
  const result = await adopt(pending.accessToken, pending.refreshToken, formString(data, "email"));
  if (result.ok) (await cookies()).delete({ name: INVITATION_LINK_SESSION_COOKIE, path: INVITATION_ACCEPT_PATH });
  return result;
}

/** "Not now": forget the verified link's session without signing in. */
export async function discardVerifiedLink(_previous: ActionResult | null, _data: FormData): Promise<ActionResult> {
  const pending = await pendingLinkSession();
  (await cookies()).delete({ name: INVITATION_LINK_SESSION_COOKIE, path: INVITATION_ACCEPT_PATH });
  // The session GoTrue minted is ended there too, not only forgotten here.
  if (pending)
    await authClient()
      .auth.admin.signOut(pending.accessToken, "local")
      .catch(() => undefined);
  return done("Not signed in.");
}
