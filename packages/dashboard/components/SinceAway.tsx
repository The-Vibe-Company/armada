"use client";

// "Since you were away" (THE-894, Night watch THE-899): on the overview, back
// after more than 30 minutes, the absence replayed on one strip (a ship for
// each merge, a tick for each start, an orange dot for what waits for the
// owner now), then each part as a link (the Activity page filtered, the
// agent, the validations). Dismissed, it fades out and stays hidden until the
// next visit. The overview's page reads it with the page, before the shell's
// beacon records this visit (`initialSince`), so it moves nothing; after a
// move inside the dashboard it is read when the beacon says there is one
// (`/api/fleet/since`).
import type { SinceSummary } from "@armada/core/read";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { activityHref } from "@/lib/activity-view";
import { paths } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import { Ship } from "./mark";
import { Button, Section } from "./page";
import { useNow, useShell } from "./shell/context";
import { useVisit } from "./shell/visit";
import { Dot } from "./ui";

/** How many stuck tickets the line names before "n more". */
const NAMED = 2;
/** The fade a dismissed summary leaves with (--t-2). */
const LEAVE_MS = 220;

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

/** A part's text with its count in bold: "<b>6</b> merged". */
function counted(text: string, n: number | string): ReactNode {
  const at = text.indexOf(String(n));
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <b>{n}</b>
      {text.slice(at + String(n).length)}
    </>
  );
}

interface Part {
  key: string;
  href: string;
  prefetch: boolean;
  mark: ReactNode;
  text: string;
  count: number | string;
  hot?: boolean;
}

function partsOf(t: Strings, s: SinceSummary): Part[] {
  const out: Part[] = [];
  if (s.merged.length)
    out.push({
      key: "merged",
      href: activityHref({ kind: "merge" }),
      prefetch: false,
      mark: <Ship color="var(--done)" size={11} />,
      text: t.since.merged(s.merged.length),
      count: s.merged.length,
    });
  if (s.started.length)
    out.push({
      key: "started",
      href: activityHref({ kind: "claim" }),
      prefetch: false,
      mark: <i className="aw-key is-started" />,
      text: t.since.started(s.started.length),
      count: s.started.length,
    });
  if (s.waiting.length)
    out.push({
      key: "waits",
      href: paths.validations,
      prefetch: true,
      mark: <Dot color="var(--accent)" />,
      text: t.since.waits(s.waiting.length),
      count: s.waiting.length,
      hot: true,
    });
  for (const x of s.stuck.slice(0, NAMED)) {
    const length = x.minutes === null ? "" : t.duration(x.minutes * 60_000);
    out.push({
      key: `${x.project}/${x.ticket}`,
      href: paths.agent(x.ticket),
      prefetch: true,
      mark: <i className="aw-key is-stuck" />,
      text:
        x.reason === "blocked"
          ? t.since.blocked(x.ticket)
          : x.ongoing
            ? t.since.silentNow(x.ticket, length)
            : t.since.silent(x.ticket, length),
      count: x.ticket,
    });
  }
  if (s.stuck.length > NAMED)
    out.push({
      key: "more",
      href: paths.agents(),
      prefetch: true,
      mark: <i className="aw-key is-stuck" />,
      text: t.since.more(s.stuck.length - NAMED),
      count: s.stuck.length - NAMED,
    });
  return out;
}

/**
 * What the overview shows of the viewer's absence: the page's reading first,
 * else the one the beacon points to; null once dismissed or when there is none.
 */
export function useSince(initial: SinceSummary | null | undefined) {
  const visit = useVisit();
  const [summary, setSummary] = useState<SinceSummary | null>(initial ?? null);
  const [dismissed, setDismissed] = useState(false);
  const beacon = visit?.answer?.since ?? null;
  useEffect(() => {
    if (initial || !beacon) return;
    let stopped = false;
    fetch("/api/fleet/since", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ summary: SinceSummary | null }>) : null))
      .then((body) => {
        if (!stopped && body) setSummary(body.summary);
      })
      .catch(() => {
        // A nicety: the overview stands without it.
      });
    return () => {
      stopped = true;
    };
  }, [initial, beacon]);
  const shown = visit && summary && !dismissed && !summary.quiet ? summary : null;
  return {
    summary: shown,
    dismiss: () => {
      setDismissed(true);
      visit?.dismiss(summary?.since);
    },
  };
}

export function SinceAway({ summary, onDismiss }: { summary: SinceSummary; onDismiss: () => void }) {
  const { t, lang } = useShell();
  const now = useNow();
  const [leaving, setLeaving] = useState(false);
  const parts = partsOf(t, summary);
  const start = Date.parse(summary.since);
  const span = Math.max(1, now - start);
  const x = (at: string) => `${Math.min(100, Math.max(0, ((Date.parse(at) - start) / span) * 100))}%`;
  const clock = sinceClock(summary.since, now, lang);
  const middle = new Date(start + span / 2).toISOString();
  const leave = () => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setLeaving(true);
    setTimeout(onDismiss, reduced ? 0 : LEAVE_MS);
  };
  return (
    <div className={leaving ? "aw is-leaving" : "aw"}>
      <Section
        icon={<Dot color="var(--frontier)" />}
        label={t.since.title}
        count={
          <time dateTime={summary.since} title={new Date(summary.since).toLocaleString(lang)}>
            {clock} → {t.since.now}
          </time>
        }
        side={
          <>
            <Link href={activityHref({})} prefetch={false} className="aw-all">
              {t.since.all}
            </Link>
            <Button type="button" tone="quiet" small onClick={leave} aria-label={t.since.dismissLabel}>
              {t.since.dismiss}
            </Button>
          </>
        }
      >
        <div className="aw-body">
          <div className="aw-strip" role="img" aria-label={t.since.strip(clock, parts.map((p) => p.text).join(", "))}>
            <span className="aw-line" />
            {summary.started.map((e) => (
              <i key={`s-${e.project}-${e.ticket}`} className="aw-tick" style={{ left: x(e.at) }} />
            ))}
            {summary.merged.map((e) => (
              <span key={`m-${e.project}-${e.ticket}`} className="aw-ship" style={{ left: x(e.at) }}>
                <Ship color="var(--done)" size={10} />
              </span>
            ))}
            {summary.waiting.length > 0 && <i className="aw-dot" />}
            <span className="aw-now" />
            <span className="aw-t is-start">{clock}</span>
            <span className="aw-t is-middle" style={{ left: "50%" }}>
              {sinceClock(middle, now, lang)}
            </span>
            <span className="aw-t is-now">{t.since.now}</span>
          </div>
          <div className="aw-parts">
            {parts.map((p) => (
              <Link key={p.key} href={p.href} prefetch={p.prefetch} className={p.hot ? "aw-part is-hot" : "aw-part"}>
                {p.mark}
                <span>{counted(p.text, p.count)}</span>
              </Link>
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}
