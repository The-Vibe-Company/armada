import { visitSince } from "@armada/core/read";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ActivityScreen } from "@/components/screens/ActivityScreen";
import { requireFleetAccess } from "@/lib/access";
import { activityHref, activityQuery, ZONE_COOKIE, zoneOf } from "@/lib/activity-view";
import { appDatabase } from "@/lib/app-db";
import { loadActivity } from "@/lib/fleet-data";
import { LANGUAGE_COOKIE, STRINGS } from "@/lib/i18n";
import { fleetOf, languageOf } from "@/lib/server";
import { viewerKey } from "@/lib/viewer";
import { readVisit } from "@/lib/visits";

// Every event of the fleet (THE-894, THE-1021). Like /insights it reads on
// the server, Postgres only (the feed's page and the viewer's last visit),
// never Linear or GitHub; its chip and page are its address.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.shell.nav.activity} — Armada` };
}

type Params = Promise<Record<string, string | string[] | undefined>>;

/** The viewer's last visit, read without recording one: the shell's beacon does that. */
async function lastVisit(now: Date): Promise<string | null> {
  try {
    const db = await appDatabase();
    const key = db && (await viewerKey(await requireFleetAccess(), false));
    return db && key ? visitSince(await readVisit(db, key), now) : null;
  } catch {
    return null;
  }
}

export default async function ActivityPage({ searchParams }: { searchParams: Params }) {
  const [{ opts, scope }, jar, params] = await Promise.all([fleetOf(), cookies(), searchParams]);
  const query = activityQuery(params);
  // An older link's filters (project, ticket, kind, who) are dropped: the address keeps only what it reads.
  const href = activityHref(query);
  const given = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map((x) => [k, x]) : v === undefined ? [] : [[k, v]],
    ),
  ).toString();
  if (given !== (href.split("?")[1] ?? "")) redirect(href);
  const t = STRINGS[languageOf(jar.get(LANGUAGE_COOKIE)?.value)];
  const now = opts.now();
  const [reading, since] = await Promise.all([loadActivity(opts, scope, query), lastVisit(now)]);
  return (
    <ActivityScreen
      t={t}
      reading={reading}
      query={query}
      zone={zoneOf(jar.get(ZONE_COOKIE)?.value)}
      now={now}
      since={since}
    />
  );
}
