import { cookies } from "next/headers";
import { Fleet } from "@/components/Fleet";
import { requireFleetAccess } from "@/lib/access";
import { passwordRequired } from "@/lib/auth-server";
import { AUTHOR_COOKIE, LANGUAGE_COOKIE } from "@/lib/i18n";
import { authorOf, getOverview, languageOf } from "@/lib/server";

// Every request reads the fleet: the page is live, never prerendered.
export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const access = await requireFleetAccess();
  const [overview, jar, params] = await Promise.all([getOverview(), cookies(), searchParams]);
  const project = typeof params.project === "string" ? params.project : null;
  const account =
    access.kind === "account"
      ? {
          name: access.viewer.user.name || access.viewer.user.email,
          email: access.viewer.user.email,
          organization: access.viewer.organization.name,
        }
      : null;
  return (
    <Fleet
      initial={overview}
      initialLanguage={languageOf(jar.get(LANGUAGE_COOKIE)?.value)}
      initialProject={project}
      account={account}
      canLogOut={access.kind === "password" && passwordRequired()}
      initialAuthor={account ? account.name : authorOf(jar.get(AUTHOR_COOKIE)?.value)}
    />
  );
}
