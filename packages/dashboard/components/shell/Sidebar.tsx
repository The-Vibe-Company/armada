"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { groupCounts } from "@/lib/coordinator-view";
import { type Place, paths, type Section } from "@/lib/fleet-view";
import { pendingValidations } from "@/lib/overview-view";
import { useFleet, useNow, useShell } from "./context";
import { Logo, SearchIcon } from "./Logo";
import { useOverviewItems } from "./use-items";

/** The menu's sections (design/dashboard-v7): the overview and the validations with their counts, Activity, Insights. */
export function useNav() {
  const { overview } = useFleet();
  const items = useOverviewItems();
  const live = items.length - groupCounts(items).merged;
  const checks = pendingValidations(overview).length;
  return [
    { key: "overview", href: paths.overview, count: live || null, hot: false },
    { key: "validations", href: paths.validations, count: checks || null, hot: checks > 0 },
    { key: "activity", href: paths.activity, count: null, hot: false },
    { key: "insights", href: paths.insights, count: null, hot: false },
  ] satisfies { key: NonNullable<Section>; href: string; count: number | null; hot: boolean }[];
}

// Insights, Activity and the organization render on the server from Postgres: opened on demand, not on every page's load.
export const prefetched = (key: NonNullable<Section>) => key === "overview" || key === "validations";

const COORDINATOR_COLOR = { active: "var(--green)", idle: "var(--amber)", unknown: "var(--text-3)" } as const;

/**
 * The sidebar (design/dashboard-v7): the mark, the organization (`org`, the
 * shell's menu), search, the sections with their counts, one line per
 * project (its coordinator's diamond, what is blocked in it, its sessions in
 * flight), the organization and the live reading. The landing's replica
 * draws it too, with the organization's name for its menu.
 */
export function Sidebar({
  section,
  place,
  org,
  onSearch,
}: {
  section: Section;
  place: Place;
  org: ReactNode;
  onSearch: () => void;
}) {
  const { t, account } = useShell();
  const { overview } = useFleet();
  const items = useOverviewItems();
  const nav = useNav();
  const now = useNow();
  return (
    <aside className="sh-side" aria-label={t.a11y.sidebar}>
      <div className="sh-brand">
        <Link href={paths.overview} prefetch className="sh-brand-home" title="Armada">
          <Logo size={18} />
          <span className="sh-brand-name">Armada</span>
        </Link>
        <span className="spacer" />
        {org}
      </div>
      <button type="button" className="sh-search" onClick={onSearch} aria-label={`${t.shell.search} (⌘K)`}>
        <SearchIcon />
        <span className="sh-search-text">{t.shell.searchTicket}</span>
        <kbd className="sh-search-key">⌘K</kbd>
      </button>
      <nav className="sh-nav" aria-label={t.a11y.sections}>
        {nav.map((n) => (
          <Link
            key={n.key}
            href={n.href}
            prefetch={prefetched(n.key)}
            className="sh-item"
            aria-current={section === n.key && place.kind !== "project" ? "page" : undefined}
          >
            <span className="sh-item-label">{t.shell.nav[n.key]}</span>
            {n.count !== null && <span className={n.hot ? "sh-count is-hot" : "sh-count"}>{n.count}</span>}
          </Link>
        ))}
      </nav>
      <nav className="sh-projects" aria-labelledby="sh-projects-h">
        <div className="sh-heading" id="sh-projects-h">
          {t.projects}
        </div>
        {overview.projects.map((p) => {
          const own = items.filter((i) => i.project === p.slug);
          const n = groupCounts(own);
          const c = p.coordinator;
          const idle = c.seenAt ? t.duration(Math.max(0, now - Date.parse(c.seenAt))) : "";
          const hint =
            c.state === "active"
              ? t.overview.coordinatorHint.active
              : c.state === "idle"
                ? t.overview.coordinatorHint.idle(idle)
                : t.overview.coordinatorHint.unknown;
          return (
            <Link
              key={p.slug}
              href={paths.project(p.slug)}
              prefetch={false}
              className="sh-item"
              aria-current={place.kind === "project" && place.slug === p.slug ? "page" : undefined}
            >
              <span className="sh-diamond" style={{ background: COORDINATOR_COLOR[c.state] }} title={hint} />
              <span className="sr-only">{hint} · </span>
              <span className="sh-item-label">{p.name}</span>
              {n.blocked > 0 && (
                <span className="sh-count is-blocked">
                  {n.blocked}
                  <span className="sr-only"> {t.overview.groups.blocked}</span>
                </span>
              )}
              <span className="sh-count">{own.length - n.merged}</span>
            </Link>
          );
        })}
      </nav>
      <span className="spacer" />
      {account && (
        <Link
          href={paths.organization}
          prefetch={false}
          className="sh-item"
          aria-current={section === "organization" ? "page" : undefined}
        >
          <span className="sh-item-label">{t.shell.tab.organization}</span>
        </Link>
      )}
      <LiveStatus />
    </aside>
  );
}

/** The live reading: a green dot and how long ago the last poll answered, amber while a poll fails. */
function LiveStatus() {
  const { t } = useShell();
  const { checkedAt, failed } = useFleet();
  const now = useNow();
  const label = failed ? t.shell.offline : checkedAt === null ? t.shell.liveWaiting : t.shell.live(now - checkedAt);
  return (
    <div className={`sh-live ${failed ? "is-failed" : ""}`}>
      <span className="sh-live-dot" aria-hidden />
      <span className="tnum">{label}</span>
    </div>
  );
}
