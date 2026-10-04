// What the shell needs from the server on a full load (THE-866): the
// overview, the viewer's language and time zone, and who is signed in with
// their organizations. Pages read the rest from the shell's poll.
import "server-only";
import { cookies, headers } from "next/headers";
import type { Account } from "@/components/shell/context";
import type { Access } from "./access";
import { requireAccounts } from "./accounts-server";
import { ZONE_COOKIE, zoneOf } from "./activity-view";
import { passwordRequired } from "./auth-server";
import { AUTHOR_COOKIE, LANGUAGE_COOKIE } from "./i18n";
import { overviewTag } from "./live-http";
import { authorOf, getOverview, languageOf } from "./server";

export async function shellProps(access: Access) {
  const [initial, jar] = await Promise.all([getOverview(), cookies()]);
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
    zone: zoneOf(jar.get(ZONE_COOKIE)?.value),
    account,
    canLogOut: access.kind === "password" && passwordRequired(),
    initialAuthor: account ? account.name : authorOf(jar.get(AUTHOR_COOKIE)?.value),
  };
}
