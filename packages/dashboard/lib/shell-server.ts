// What the shell needs from the server on a full load (THE-866): the
// overview, the viewer's language and density, and who is signed in with
// their organizations, and their saved views. Pages read the rest from the
// shell's poll.
import "server-only";
import { cookies, headers } from "next/headers";
import type { Account } from "@/components/shell/context";
import type { Access } from "./access";
import { requireAccounts } from "./accounts-server";
import { appDatabase } from "./app-db";
import { passwordRequired } from "./auth-server";
import type { SavedView } from "./filters";
import { DENSITY_COOKIE, densityOf } from "./fleet-view";
import { AUTHOR_COOKIE, LANGUAGE_COOKIE } from "./i18n";
import { overviewTag } from "./live-http";
import { authorOf, getOverview, languageOf } from "./server";
import { listViews } from "./views";

/** The viewer's saved views (THE-895); null under the password gate, where the browser keeps them. */
async function viewsOf(access: Access): Promise<SavedView[] | null> {
  if (access.kind !== "account") return null;
  try {
    const db = await appDatabase();
    if (!db) return [];
    return await listViews(db, { organization: access.viewer.organization.id, person: access.viewer.user.id });
  } catch (err) {
    console.error(`armada dashboard: reading the saved views failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export async function shellProps(access: Access) {
  const [initial, jar, views] = await Promise.all([getOverview(), cookies(), viewsOf(access)]);
  let account: Account | null = null;
  if (access.kind === "account") {
    const { viewer } = access;
    const { auth } = await requireAccounts();
    const listed = await auth.api.listOrganizations({ headers: await headers() }).catch(() => []);
    account = {
      name: viewer.user.name || viewer.user.email,
      email: viewer.user.email,
      organization: { id: viewer.organization.id, name: viewer.organization.name },
      organizations: listed.map((o) => ({ id: o.id, name: o.name })),
    };
  }
  return {
    initial,
    initialTag: overviewTag(initial),
    initialLanguage: languageOf(jar.get(LANGUAGE_COOKIE)?.value),
    initialDensity: densityOf(jar.get(DENSITY_COOKIE)?.value),
    account,
    canLogOut: access.kind === "password" && passwordRequired(),
    initialAuthor: account ? account.name : authorOf(jar.get(AUTHOR_COOKIE)?.value),
    views,
  };
}
