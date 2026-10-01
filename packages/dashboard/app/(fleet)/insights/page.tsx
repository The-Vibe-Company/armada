import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { InsightsScreen } from "@/components/screens/InsightsScreen";
import { loadInsights } from "@/lib/fleet-data";
import { LANGUAGE_COOKIE, STRINGS } from "@/lib/i18n";
import { insightsQuery } from "@/lib/insights-view";
import { fleetOf, languageOf } from "@/lib/server";

// How fast the fleet ships and where tickets wait (THE-893). Unlike the
// pages that render from the overview the shell polls, it reads its numbers
// here, on the server: Postgres only (each project's records, kept a minute
// per range), never Linear or GitHub.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.shell.nav.insights} — Armada` };
}

type Params = Promise<Record<string, string | string[] | undefined>>;

export default async function InsightsPage({ searchParams }: { searchParams: Params }) {
  const [{ opts, scope }, jar, params] = await Promise.all([fleetOf(), cookies(), searchParams]);
  const t = STRINGS[languageOf(jar.get(LANGUAGE_COOKIE)?.value)];
  const query = insightsQuery(params);
  const reading = await loadInsights(opts, scope, { range: query.range, project: query.project });
  if (!reading) notFound();
  return <InsightsScreen t={t} reading={reading} query={query} />;
}
