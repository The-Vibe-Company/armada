"use client";

import type { FleetOverview } from "@armada/core/read";
// The frame every screen lives in (THE-1020, design/dashboard-v7): the
// sidebar (the mark, the organization, search, the overview and the
// validations with their counts, Activity, Insights, one line per project
// with its coordinator and what is blocked in it, the organization and the
// live reading) and the main panel under its header bar (the page kit's
// PageHeader: breadcrumbs, the page's actions), ⌘K search and the keyboard
// (j/k move through the rows of the page, Enter opens, Esc goes back). On a
// phone the sidebar is a top bar (the mark, the organization, search) and the
// sections a tab bar at the bottom. Pages render inside it from the overview
// it polls (`useFleet`).
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { signOut, switchOrganization } from "@/app/auth-actions";
import { type Crumb, crumbsOf, escapeTarget, paths, placeOf, type Section, sectionOf } from "@/lib/fleet-view";
import { LANGUAGES, type Language, type Strings } from "@/lib/i18n";
import { ownsKeys } from "@/lib/keyboard";
import { Alert, Button } from "../page";
import { HeaderSlotProvider, PageHeader } from "../page-client";
import { useLazy } from "../use-lazy";
import { Announcer } from "./Announcer";
import { type Account, FleetProvider, useFleet, useNow, useShell } from "./context";
import { ChevronIcon, SectionIcon } from "./icons";
import { NotifyMenu } from "./NotifyMenu";
import { prefetched, Sidebar, useNav } from "./Sidebar";
import { VisitProvider } from "./visit";

// ⌘K and its index load apart from every page, as soon as the browser is idle (THE-892).
const loadPalette = () => import("./Palette").then((m) => m.Palette);
// Owner alerts are checked after the first paint, alongside the visit reading.
const loadNotifier = () => import("./Notifier").then((m) => m.Notifier);

export function Shell({
  initial,
  initialTag,
  initialLanguage,
  zone,
  account,
  canLogOut,
  initialAuthor,
  children,
}: {
  initial: FleetOverview;
  /** The ETag `/api/fleet` gives `initial`: the first poll answers 304 while nothing changed. */
  initialTag: string;
  initialLanguage: Language;
  /** The viewer's time zone, from its cookie. */
  zone: string;
  account: Account | null;
  canLogOut: boolean;
  initialAuthor: string;
  children: ReactNode;
}) {
  return (
    <FleetProvider
      initial={initial}
      initialTag={initialTag}
      initialLanguage={initialLanguage}
      zone={zone}
      account={account}
      canLogOut={canLogOut}
      initialAuthor={initialAuthor}
    >
      <VisitProvider>
        <Frame>{children}</Frame>
      </VisitProvider>
    </FleetProvider>
  );
}

/**
 * The page an agent's page was opened from, for its breadcrumbs, its sidebar
 * entry and where Esc leads. Moving from one agent to another keeps the first one's.
 */
function useFrom(pathname: string): string | null {
  const [trail, setTrail] = useState<{ path: string; from: string | null }>({ path: pathname, from: null });
  if (trail.path !== pathname) {
    const fromAgent = placeOf(pathname).kind === "agent" && placeOf(trail.path).kind === "agent";
    setTrail({ path: pathname, from: fromAgent ? trail.from : trail.path });
  }
  return trail.from;
}

function Frame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t, account } = useShell();
  const { overview } = useFleet();
  const place = useMemo(() => placeOf(pathname), [pathname]);
  const fromPath = useFrom(pathname);
  const [palette, setPalette] = useState(false);
  const Palette = useLazy(loadPalette);
  const Notifier = useLazy(loadNotifier);
  const [menu, setMenu] = useState(false);
  const main = useRef<HTMLDivElement>(null);
  const selected = useRef(-1);

  const rows = useCallback(
    () => Array.from(main.current?.querySelectorAll<HTMLAnchorElement>("a[data-row]") ?? []),
    [],
  );
  const select = useCallback(
    (index: number) => {
      const list = rows();
      for (const r of list) r.removeAttribute("data-selected");
      selected.current = list.length ? Math.max(0, Math.min(list.length - 1, index)) : -1;
      const row = list[selected.current];
      if (!row) return;
      row.setAttribute("data-selected", "");
      row.scrollIntoView({ block: "nearest" });
      router.prefetch(row.getAttribute("href") ?? "/");
    },
    [rows, router],
  );

  // A new page starts with nothing selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on each page change.
  useEffect(() => {
    selected.current = -1;
    setMenu(false);
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((open) => !open);
        return;
      }
      if (palette || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || ownsKeys(e.target)) return;
      if (e.key === "Escape") {
        if (menu) return setMenu(false);
        const to = escapeTarget(place, fromPath);
        if (to) router.push(to);
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown" || e.key === "k" || e.key === "ArrowUp") {
        if (!rows().length) return;
        e.preventDefault();
        const down = e.key === "j" || e.key === "ArrowDown";
        select(selected.current < 0 ? 0 : selected.current + (down ? 1 : -1));
        return;
      }
      if (e.key === "Enter" && selected.current >= 0) {
        const row = rows()[selected.current];
        // A focused control (a link, a tab, a button) answers Enter itself; the page (after "Skip to content") does not.
        const focused = document.activeElement;
        if (row && (!focused || focused === document.body || focused.id === "content")) {
          e.preventDefault();
          const href = row.getAttribute("href") ?? "/";
          // Another site's page (a merged pull request) opens in a new tab, as a click does.
          if (row.target === "_blank") window.open(href, "_blank", "noreferrer");
          else router.push(href);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, menu, place, fromPath, router, rows, select]);

  const section = sectionOf(place);
  const agentProject =
    place.kind === "agent"
      ? (overview.rows.find((r) => r.id.toLowerCase() === place.ticket.toLowerCase())?.project ?? null)
      : null;
  const crumbs = crumbsOf(place, agentProject);
  const names = new Map(overview.projects.map((p) => [p.slug, p.name]));
  const here = crumbs.at(-1);

  return (
    // The approval link is opened from a phone as often as a desk: on a narrow screen it takes the whole width.
    <div className={place.kind === "validation" ? "sh is-focus" : "sh"}>
      <a className="sh-skip" href="#content">
        {t.a11y.skip}
      </a>
      <Sidebar
        section={section}
        place={place}
        org={<OrgMenu open={menu} setOpen={setMenu} label={account?.organization.name ?? ""} />}
        onSearch={() => setPalette(true)}
      />
      <main className="sh-main" id="content" tabIndex={-1}>
        <HeaderSlotProvider>
          <PageHeader
            heading={here ? crumbLabel(t, here, names) : t.htmlTitle}
            title={<Crumbs crumbs={crumbs} names={names} />}
          />
          <div className="sh-scroll" ref={main}>
            <FleetAlert />
            {children}
          </div>
        </HeaderSlotProvider>
      </main>
      <TabBar section={section} />
      {palette && Palette && <Palette onClose={() => setPalette(false)} />}
      <Announcer />
      {Notifier && <Notifier />}
    </div>
  );
}

function crumbLabel(t: Strings, c: Crumb, names: Map<string, string>) {
  switch (c.kind) {
    case "overview":
    case "validations":
    case "insights":
    case "activity":
      return t.shell.nav[c.kind];
    case "validation":
      return `#${c.id}`;
    case "project":
      return names.get(c.slug) ?? c.slug;
    case "agent":
      return c.ticket;
    case "organization":
      return t.org.nav;
    case "organization-page":
      return t[c.page].nav;
  }
}

function Crumbs({ crumbs, names }: { crumbs: Crumb[]; names: Map<string, string> }) {
  const { t } = useShell();
  return (
    <nav className="sh-crumbs" aria-label={t.a11y.breadcrumb}>
      {crumbs.map((c, i) => (
        <span key={c.kind} className="sh-crumb">
          {i > 0 && (
            <span className="sh-crumb-sep" aria-hidden>
              /
            </span>
          )}
          {c.href ? (
            <Link href={c.href} prefetch>
              {crumbLabel(t, c, names)}
            </Link>
          ) : (
            <span aria-current="page">{crumbLabel(t, c, names)}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * The sections on a phone (THE-899): a tab bar at the bottom, each with its
 * label and, when something waits for the viewer, its count. Shown under
 * 720 px only, where the sidebar's sections are hidden.
 */
function TabBar({ section }: { section: Section }) {
  const { t, account } = useShell();
  const nav: { key: NonNullable<Section>; href: string; count: number | null; hot: boolean }[] = useNav();
  if (account) nav.push({ key: "organization", href: paths.organization, count: null, hot: false });
  return (
    <nav className="sh-tabbar" aria-label={t.a11y.sections}>
      {nav.map((n) => (
        <Link
          key={n.key}
          href={n.href}
          prefetch={prefetched(n.key)}
          className="sh-tab"
          aria-current={section === n.key ? "page" : undefined}
        >
          <SectionIcon section={n.key} size={18} />
          <span className="sh-tab-label">{t.shell.tab[n.key]}</span>
          {n.hot && n.count !== null && <span className="sh-tab-badge">{n.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/**
 * A poll that failed, on every page (THE-899): the page keeps the last
 * reading under it, says since when, and offers to try again.
 */
function FleetAlert() {
  const { t } = useShell();
  const { checkedAt, failed, refresh } = useFleet();
  const now = useNow();
  if (!failed) return null;
  return (
    <Alert
      title={t.shell.offline}
      action={
        <Button type="button" small onClick={refresh}>
          {t.refresh}
        </Button>
      }
    >
      {checkedAt !== null && t.staleReading(now - checkedAt)}
    </Alert>
  );
}

/**
 * The organization switcher: the viewer's organizations, the organization's
 * pages, the language and sign out. A disclosure (THE-891): Tab moves through
 * it, Esc or leaving it closes it, and Esc gives the focus back to its button.
 */
function OrgMenu({ open, setOpen, label }: { open: boolean; setOpen: (open: boolean) => void; label: string }) {
  const { t, lang, setLanguage, account, canLogOut } = useShell();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, setOpen]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc and focus leaving close the disclosure it holds.
    <div
      className="sh-org"
      ref={box}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.preventDefault();
        setOpen(false);
        button.current?.focus();
      }}
      onBlur={(e) => {
        if (open && e.relatedTarget && !box.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className="sh-org-button"
        aria-expanded={open}
        aria-controls="sh-menu"
        aria-label={t.shell.organizationMenu}
        onClick={() => setOpen(!open)}
      >
        <span className="sh-org-name">{label}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="sh-menu" id="sh-menu">
          {account && (
            <>
              <div className="sh-menu-h">{t.shell.organizations}</div>
              {account.organizations.map((o) =>
                o.id === account.organization.id ? (
                  <div key={o.id} className="sh-menu-item is-current" aria-current="true">
                    <span className="sh-menu-check" aria-hidden>
                      ✓
                    </span>
                    {o.name}
                  </div>
                ) : (
                  <form key={o.id} action={switchOrganization}>
                    <input type="hidden" name="organization" value={o.id} />
                    <button type="submit" className="sh-menu-item">
                      <span className="sh-menu-check" aria-hidden />
                      {o.name}
                    </button>
                  </form>
                ),
              )}
              <div className="sh-menu-sep" />
              <Link href="/organization" className="sh-menu-item">
                {t.org.nav}
              </Link>
              <Link href="/organization/keys" className="sh-menu-item">
                {t.keys.nav}
              </Link>
              <Link href="/organization/github" className="sh-menu-item">
                {t.github.nav}
              </Link>
              <Link href="/organization/workers" className="sh-menu-item">
                {t.workers.nav}
              </Link>
              <div className="sh-menu-sep" />
            </>
          )}
          <div className="sh-menu-row">
            <span>{t.language}</span>
            <span className="spacer" />
            <fieldset className="lang">
              <legend className="sr-only">{t.language}</legend>
              {LANGUAGES.map((l) => (
                <button key={l} type="button" aria-pressed={l === lang} onClick={() => setLanguage(l)}>
                  {l.toUpperCase()}
                </button>
              ))}
            </fieldset>
          </div>
          <NotifyMenu />
          {account && (
            <>
              <div className="sh-menu-sep" />
              <div className="sh-menu-who">
                <span>{account.name}</span>
                <span className="faint">{account.email}</span>
              </div>
              <form action={signOut}>
                <button type="submit" className="sh-menu-item">
                  {t.auth.logout}
                </button>
              </form>
            </>
          )}
          {canLogOut && (
            <form method="post" action="/api/auth/logout">
              <button type="submit" className="sh-menu-item">
                {t.gate.logout}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
