"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { type ActionResult, done, fail } from "@/lib/action";
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

export type EmailLinkCheck =
  | { ok: true; email: string; orgName: string; currentEmail: string | null }
  | { ok: false; error: string };

/** Who the fragment's session signs in as, and for which org, before anything is stored. */
export async function inspectEmailLink(hash: string): Promise<EmailLinkCheck> {
  const fragment = parseEmailLinkFragment(hash);
  if (!fragment) return { ok: false, error: LINK_INVALID };
  if (fragment.kind === "error") return { ok: false, error: fragment.expired ? LINK_EXPIRED : LINK_INVALID };
  const found = await candidate(fragment.accessToken);
  if (isFailure(found)) return found.ok ? { ok: false, error: LINK_INVALID } : found;
  const viewer = await readViewer();
  return {
    ok: true,
    email: found.email,
    orgName: found.orgName,
    currentEmail: viewer && viewer.id !== found.id ? viewer.email || "another account" : null,
  };
}

/** The explicit "continue as …" of the fragment's session. */
export async function adoptEmailLink(hash: string): Promise<ActionResult> {
  const fragment = parseEmailLinkFragment(hash);
  if (fragment?.kind !== "session") return fail(LINK_INVALID);
  const result = await adopt(fragment.accessToken, fragment.refreshToken);
  if (result.ok) revalidatePath(INVITATION_ACCEPT_PATH);
  return result;
}

/**
 * First step of a `token_hash` link: verify it once at GoTrue and check whose it is. The minted session waits in an
 * HTTP-only cookie scoped to this page; the page then asks "continue as …" and nothing is signed in yet.
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

/** Second step: the explicit "continue as …" of the verified link's account. */
export async function adoptVerifiedLink(_previous: ActionResult | null, _data: FormData): Promise<ActionResult> {
  const pending = await pendingLinkSession();
  if (!pending) return fail(LINK_EXPIRED);
  // Shown to a signed-out viewer only: if another account signed in since (another tab), it is not replaced here.
  const viewer = await readViewer();
  if (viewer) return fail(`This browser is now signed in as ${viewer.email || "another account"}. Reload the page.`);
  const result = await adopt(pending.accessToken, pending.refreshToken);
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
