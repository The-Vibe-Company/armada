"use client";

// The v4 frame every screen lives in (THE-866): the sidebar, the header bar
// (the page kit's PageHeader: breadcrumbs, key hints, the page's actions),
// ⌘K search and the keyboard (j/k move through the rows of the page, Enter
// opens, Esc goes back). Pages render inside it from the overview it polls
// (`useFleet`).
import type { FleetOverview } from "@armada/core/read";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { signOut, switchOrganization } from "@/app/auth-actions";
import {
  type Crumb,
  crumbsOf,
  type Density,
  escapeTarget,
  HARNESS_NAME,
  HARNESSES,
  harnessCounts,
  type Place,
  paths,
  placeOf,
  type Section,
  sectionOf,
} from "@/lib/fleet-view";
import { LANGUAGES, type Language, type Strings } from "@/lib/i18n";
import { ownsKeys } from "@/lib/keyboard";
import { decideCount, pendingValidations } from "@/lib/overview-view";
import { HeaderSlotProvider, PageHeader } from "../page-client";
import { Dot, harnessColor, Kbd, ProjectChip } from "../ui";
import { Announcer } from "./Announcer";
import { type Account, FleetProvider, useFleet, useNow, useShell } from "./context";
import { Logo, SearchIcon } from "./Logo";
import { Palette } from "./Palette";

export function Shell({
  initial,
  initialLanguage,
  initialDensity,
  account,
  canLogOut,
  initialAuthor,
  children,
}: {
  initial: FleetOverview;
  initialLanguage: Language;
  initialDensity: Density;
  account: Account | null;
  canLogOut: boolean;
  initialAuthor: string;
  children: ReactNode;
}) {
  return (
    <FleetProvider
      initial={initial}
      initialLanguage={initialLanguage}
      initialDensity={initialDensity}
      account={account}
      canLogOut={canLogOut}
      initialAuthor={initialAuthor}
    >
      <Frame>{children}</Frame>
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
  const { t, density } = useShell();
  const { overview } = useFleet();
  const place = useMemo(() => placeOf(pathname), [pathname]);
  const fromPath = useFrom(pathname);
  const from = useMemo(() => (fromPath === null ? null : placeOf(fromPath)), [fromPath]);
  const [palette, setPalette] = useState(false);
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
          router.push(row.getAttribute("href") ?? "/");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, menu, place, fromPath, router, rows, select]);

  const section = sectionOf(place, from);
  const listPage =
    place.kind === "overview" || place.kind === "agents" || place.kind === "projects" || place.kind === "validations";
  const detailPage = place.kind === "agent" || place.kind === "project" || place.kind === "validation";
  const crumbs = crumbsOf(place, from);
  const names = new Map(overview.projects.map((p) => [p.slug, p.name]));
  const here = crumbs.at(-1);

  return (
    // The approval link is opened from a phone as often as a desk: on a narrow screen it takes the whole width.
    <div className={place.kind === "validation" ? "sh is-focus" : "sh"}>
      <a className="sh-skip" href="#content">
        {t.a11y.skip}
      </a>
      <Sidebar section={section} place={place} menu={menu} setMenu={setMenu} onSearch={() => setPalette(true)} />
      <main className="sh-main" id="content" tabIndex={-1} data-density={density}>
        <HeaderSlotProvider>
          <PageHeader
            heading={here ? crumbLabel(t, here, names) : t.htmlTitle}
            title={<Crumbs crumbs={crumbs} names={names} />}
            hints={
              detailPage ? (
                <>
                  <Kbd>esc</Kbd>
                  {t.shell.back}
                </>
              ) : listPage ? (
                <>
                  <Kbd>j k</Kbd>
                  {t.shell.navigate} <Kbd>↵</Kbd>
                  {t.shell.open}
                </>
              ) : null
            }
          />
          <div className="sh-scroll" ref={main}>
            {children}
          </div>
        </HeaderSlotProvider>
      </main>
      {palette && <Palette onClose={() => setPalette(false)} />}
      <Announcer />
    </div>
  );
}

function crumbLabel(t: Strings, c: Crumb, names: Map<string, string>) {
  switch (c.kind) {
    case "overview":
    case "projects":
    case "agents":
    case "validations":
    case "insights":
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
    case "design":
      return t.shell.design.title;
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
              ›
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

function NavIcon({ section }: { section: NonNullable<Section> }) {
  return <span className={`sh-nav-icon is-${section}`} aria-hidden />;
}

function Sidebar({
  section,
  place,
  menu,
  setMenu,
  onSearch,
}: {
  section: Section;
  place: Place;
  menu: boolean;
  setMenu: (open: boolean) => void;
  onSearch: () => void;
}) {
  const { t, account } = useShell();
  const { overview } = useFleet();
  const counts = harnessCounts(overview.rows);
  const decisions = decideCount(overview);
  const checks = pendingValidations(overview).length;
  const nav: { key: NonNullable<Section>; href: string; count: number | null; hot: boolean }[] = [
    { key: "overview", href: paths.overview, count: decisions, hot: decisions > 0 },
    { key: "validations", href: paths.validations, count: checks, hot: checks > 0 },
    { key: "projects", href: paths.projects, count: overview.projects.length, hot: false },
    { key: "agents", href: paths.agents(), count: overview.rows.length, hot: false },
    { key: "insights", href: paths.insights, count: null, hot: false },
  ];
  return (
    <aside className="sh-side" aria-label={t.a11y.sidebar}>
      <div className="sh-brand">
        <Link href={paths.overview} prefetch className="sh-brand-home" title="Armada">
          <Logo />
          <span className="sh-label sh-brand-name">Armada</span>
        </Link>
        <span className="spacer sh-label" />
        <OrgMenu open={menu} setOpen={setMenu} label={account?.organization.name ?? ""} />
      </div>
      <button type="button" className="sh-search" onClick={onSearch} title={`${t.shell.search} (⌘K)`}>
        <SearchIcon />
        <span className="sh-label">{t.shell.search}</span>
        <span className="spacer sh-label" />
        <Kbd>⌘K</Kbd>
      </button>
      <nav className="sh-nav" aria-label={t.a11y.sections}>
        {nav.map((n) => (
          <Link
            key={n.key}
            href={n.href}
            // Insights renders on the server from Postgres: opened on demand, not on every page's load.
            prefetch={n.key !== "insights"}
            className="sh-nav-item"
            aria-current={section === n.key ? "page" : undefined}
            title={t.shell.nav[n.key]}
          >
            <NavIcon section={n.key} />
            <span className="sh-label sh-nav-label">{t.shell.nav[n.key]}</span>
            {n.count !== null && <span className={`sh-count ${n.hot ? "is-hot" : ""}`}>{n.count}</span>}
          </Link>
        ))}
      </nav>
      {overview.projects.length > 0 && (
        <nav className="sh-group" aria-labelledby="sh-projects-h">
          <div className="sh-group-h sh-label" id="sh-projects-h">
            {t.shell.projectsHeading}
          </div>
          {overview.projects.map((p) => (
            <Link
              key={p.slug}
              href={paths.project(p.slug)}
              prefetch
              className="sh-item"
              title={p.name}
              aria-current={place.kind === "project" && place.slug === p.slug ? "page" : undefined}
            >
              <span className="sh-item-icon">
                <ProjectChip slug={p.slug} bare />
              </span>
              <span className="sh-label">{p.name}</span>
              <span className="sh-count">{p.inFlight}</span>
            </Link>
          ))}
        </nav>
      )}
      <nav className="sh-group" aria-labelledby="sh-harness-h">
        <div className="sh-group-h sh-label" id="sh-harness-h">
          {t.shell.harnessHeading}
        </div>
        {HARNESSES.map((h) => {
          const name = h === "conductor" ? HARNESS_NAME[h] : t.shell.local(HARNESS_NAME[h]);
          return (
            <Link key={h} href={paths.agents(h)} prefetch className="sh-item" title={name}>
              <span className="sh-item-icon">
                <Dot color={harnessColor(h)} />
              </span>
              <span className="sh-label">{name}</span>
              <span className="sh-count">{counts[h]}</span>
            </Link>
          );
        })}
        <div className="sh-item is-soon sh-label">
          <span className="sh-item-icon">
            <span className="sh-soon-dot" aria-hidden />
          </span>
          <span>boat.dev</span>
          <span className="spacer" />
          <span className="sh-soon">{t.shell.soon}</span>
        </div>
      </nav>
      <span className="spacer" />
      <LiveStatus />
    </aside>
  );
}

function LiveStatus() {
  const { t } = useShell();
  const { checkedAt, failed } = useFleet();
  const now = useNow();
  const label = failed ? t.shell.offline : checkedAt === null ? t.shell.liveWaiting : t.shell.live(now - checkedAt);
  return (
    <div className={`sh-live ${failed ? "is-failed" : ""}`} title={label}>
      <Dot color={failed ? "var(--critical)" : "var(--done)"} pulse={failed ? undefined : "live"} />
      <span className="sh-label tnum">{label}</span>
    </div>
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
        <span className="sh-label sh-org-name">{label}</span>
        <span aria-hidden>▾</span>
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
