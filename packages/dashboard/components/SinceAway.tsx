"use client";

// "Since you were away" (THE-894): on the overview, back after more than 30
// minutes, one line of what happened since the last visit: what merged, what
// started, what got stuck and what waits for the owner now, each part a link
// (the Activity page filtered, the agent, the validations). Dismissed, it
// stays hidden until the next visit. It reads the shell's visit beacon
// (components/shell/visit.tsx), computed from Postgres.
import type { SinceSummary } from "@armada/core/read";
import Link from "next/link";
import type { ReactNode } from "react";
import { activityHref } from "@/lib/activity-view";
import { paths } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import { Button, Section, SectionBody } from "./page";
import { useNow, useShell } from "./shell/context";
import { useVisit } from "./shell/visit";
import { Dot } from "./ui";

/** How many stuck tickets the line names before "n more". */
const NAMED = 2;

/** "14:20" today, "Tue 14:20" this week, "3 Mar 14:20" before. */
export function sinceClock(at: string, now: number, locale: string): string {
  const d = new Date(at);
  const days = (now - d.getTime()) / 86_400_000;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return d.toLocaleString(locale, {
    ...(sameDay ? {} : days < 6 ? { weekday: "short" } : { day: "numeric", month: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function parts(t: Strings, s: SinceSummary): ReactNode[] {
  const out: ReactNode[] = [];
  if (s.merged.length)
    out.push(
      <Link key="merged" href={activityHref({ kind: "merge" })} prefetch={false} className="since-link">
        {t.since.merged(s.merged.length)}
      </Link>,
    );
  if (s.started.length)
    out.push(
      <Link key="started" href={activityHref({ kind: "claim" })} prefetch={false} className="since-link">
        {t.since.started(s.started.length)}
      </Link>,
    );
  if (s.waiting.length)
    out.push(
      <Link key="waits" href={paths.validations} className="since-link is-hot">
        {t.since.waits(s.waiting.length)}
      </Link>,
    );
  for (const x of s.stuck.slice(0, NAMED)) {
    const length = x.minutes === null ? "" : t.duration(x.minutes * 60_000);
    out.push(
      <Link key={`${x.project}/${x.ticket}`} href={paths.agent(x.ticket)} className="since-link">
        {x.reason === "blocked"
          ? t.since.blocked(x.ticket)
          : x.ongoing
            ? t.since.silentNow(x.ticket, length)
            : t.since.silent(x.ticket, length)}
      </Link>,
    );
  }
  if (s.stuck.length > NAMED)
    out.push(
      <Link key="more" href={paths.agentGroup("silent")} className="since-link">
        {t.since.more(s.stuck.length - NAMED)}
      </Link>,
    );
  return out;
}

export function SinceAway() {
  const visit = useVisit();
  const { t, lang } = useShell();
  const now = useNow();
  const summary = visit?.answer?.summary;
  if (!visit || !summary) return null;
  const list = parts(t, summary);
  const clock = sinceClock(summary.since, now, lang);
  return (
    <Section
      icon={<Dot color="var(--frontier)" />}
      label={t.since.title}
      side={
        <Button type="button" onClick={visit.dismiss} aria-label={t.since.dismissLabel} className="since-dismiss">
          {t.since.dismiss}
        </Button>
      }
    >
      <SectionBody className="since">
        <p>
          <time dateTime={summary.since} title={new Date(summary.since).toLocaleString(lang)}>
            {t.since.since(clock)}
          </time>
          {": "}
          {summary.quiet
            ? t.since.quiet
            : list.map((p, k) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the parts keep one order.
                <span key={k}>
                  {k > 0 && <span aria-hidden> · </span>}
                  {k > 0 && <span className="sr-only">, </span>}
                  {p}
                </span>
              ))}{" "}
          <Link href={activityHref({})} prefetch={false} className="since-all">
            {t.since.all} →
          </Link>
        </p>
      </SectionBody>
    </Section>
  );
}
