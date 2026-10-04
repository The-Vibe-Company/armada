import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { InsightsScreen } from "@/components/screens/InsightsScreen";
import { loadInsights } from "@/lib/fleet-data";
import { LANGUAGE_COOKIE, STRINGS } from "@/lib/i18n";
import { INSIGHTS_RANGE } from "@/lib/insights-view";
import { fleetOf, languageOf } from "@/lib/server";

// How fast the fleet ships (THE-893, THE-1021): the last seven days of every
// project. Unlike the pages that render from the overview the shell polls,
// it reads its numbers here, on the server: Postgres only (each project's
// records, kept a minute), never Linear or GitHub. Older links' `?range=`
// and `?project=` are ignored.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.shell.nav.insights} — Armada` };
}

export default async function InsightsPage() {
  const [{ opts, scope }, jar] = await Promise.all([fleetOf(), cookies()]);
  const t = STRINGS[languageOf(jar.get(LANGUAGE_COOKIE)?.value)];
  const reading = await loadInsights(opts, scope, { range: INSIGHTS_RANGE, project: null, perProject: true });
  if (!reading) notFound();
  return <InsightsScreen t={t} reading={reading} />;
}
