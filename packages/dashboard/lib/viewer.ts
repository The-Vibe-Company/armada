// Whose visits a request records (THE-894): a signed-in person in their
// organization, or, under the shared-password gate, this browser, by a random
// id in an httpOnly cookie set on its first visit.
import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { Access } from "./access";
import type { ViewerKey } from "./visits";

export const VIEWER_COOKIE = "armada-viewer";

const BROWSER_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** The viewer of this request; null for a browser with no id yet when `create` is false (a page cannot set one). */
export async function viewerKey(access: Access, create: boolean): Promise<ViewerKey | null> {
  if (access.kind === "account")
    return { viewer: `user:${access.viewer.user.id}`, organization: access.viewer.organization.id };
  const jar = await cookies();
  const held = jar.get(VIEWER_COOKIE)?.value;
  if (held && BROWSER_ID.test(held)) return { viewer: `browser:${held}`, organization: "" };
  if (!create) return null;
  const id = randomBytes(18).toString("base64url");
  jar.set(VIEWER_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 365 * 24 * 3600,
  });
  return { viewer: `browser:${id}`, organization: "" };
}
