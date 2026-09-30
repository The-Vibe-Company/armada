import { cookies } from "next/headers";
import { Fleet } from "@/components/Fleet";
import { passwordRequired } from "@/lib/auth-server";
import { AUTHOR_COOKIE, LANGUAGE_COOKIE } from "@/lib/i18n";
import { authorOf, getOverview, languageOf } from "@/lib/server";

// Every request reads the fleet: the page is live, never prerendered.
export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const [overview, jar, params] = await Promise.all([getOverview(), cookies(), searchParams]);
  const project = typeof params.project === "string" ? params.project : null;
  return (
    <Fleet
      initial={overview}
      initialLanguage={languageOf(jar.get(LANGUAGE_COOKIE)?.value)}
      initialProject={project}
      canLogOut={passwordRequired()}
      initialAuthor={authorOf(jar.get(AUTHOR_COOKIE)?.value)}
    />
  );
}
