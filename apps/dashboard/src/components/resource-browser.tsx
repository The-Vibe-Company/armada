"use client";

import { SearchIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type Blocker, FILTER_FROM, ITEM_PARAM, matchesQuery } from "@/lib/resource-list";
import { cn } from "@/lib/utils";

/**
 * The skeleton every Build page shares (#808): the readiness strip on top, one dense list (a row per item, its
 * state and its one expected action), and full-width details above the list for everything rare (a sheet on a phone). A
 * page's create flow is a `CreateDialog` passed as `actions` (#896, #898), never this panel. The page renders
 * each row's cells and panel on the server; this component only chooses which panel shows.
 *
 * Every panel stays mounted, hidden when another is selected: a form that follows a build keeps its state while
 * the person looks at another row.
 */
export type ResourceRow = {
  /** Stable and unique: the panel key and the `?item=` value. */
  key: string;
  name: string;
  /** Everything the filter matches: name, provider, repositories, URL… */
  search: string;
  mark?: ReactNode;
  /** Small tags beside the name (Personal, Org, Private). */
  tags?: ReactNode;
  /** One line under the name: provider · scope · age. */
  meta: ReactNode;
  state: ReactNode;
  /** The useful fact: the repositories of an environment, the identity and tool count of a tool. */
  fact?: ReactNode;
  /** The one expected action, as a button. Stays above the row's select target. */
  action?: ReactNode;
  /** The panel's subtitle under the name. */
  subtitle?: ReactNode;
  detail: ReactNode;
  /** `data-*` attributes of the row and of its panel, for tests and styling. */
  attrs?: Record<string, string>;
  panelAttrs?: Record<string, string>;
};

type BrowserContext = { select: (key: string | null) => void; selected: string | null; panelId: string };
const Context = createContext<BrowserContext | null>(null);

function useBrowser(): BrowserContext {
  const value = useContext(Context);
  if (!value) throw new Error("outside a ResourceBrowser");
  return value;
}

/** Lazy resource details can load only while their panel is selected. */
export function useResourceSelected(key: string): boolean {
  return useBrowser().selected === key;
}

export function ResourceBrowser({
  title,
  description,
  meta,
  label,
  rows,
  blockers,
  notices,
  actions,
  footer,
  empty,
  initial,
  detailPanel = false,
}: {
  title: string;
  description: string;
  meta?: ReactNode;
  /** The list's accessible name. */
  label: string;
  rows: ResourceRow[];
  blockers: Blocker[];
  /** Page-level notices (a removal confirmed, a sign-in that came back) between the strip and the list. */
  notices?: ReactNode;
  /** Header controls: the page's create flow, a `CreateDialog` (#896). */
  actions?: ReactNode;
  /** What follows the list: a quiet line (the capacity), or a section of its own. */
  footer?: ReactNode;
  empty: ReactNode;
  /** The panel open on the first render: the `?item=` of the URL, or what the page follows. */
  initial: string | null;
  /** Opt in one page family at a time to the shared right-hand modal detail. */
  detailPanel?: boolean;
}) {
  const keys = useMemo(() => new Set(rows.map((row) => row.key)), [rows]);
  const valid = useCallback((key: string | null) => key !== null && keys.has(key), [keys]);
  const [chosen, setChosen] = useState<string | null>(initial);
  // A row removed by an action, or a stale link, closes the panel rather than showing nothing.
  const selected = chosen !== null && valid(chosen) ? chosen : null;
  const [query, setQuery] = useState("");
  const browserId = useId();
  const panelId = `${browserId}-panel`;
  const titleId = `${browserId}-panel-title`;
  const rootRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<string | null>(null);
  const wide = useSyncExternalStore(subscribeWide, readWide, () => true);
  const sheet = selected !== null && (detailPanel || !wide);
  // The portal target never changes. Moving this host, rather than changing React
  // parents, retains every detail form and build follower across breakpoints.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const desktopHost = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    setHost(document.createElement("div"));
  }, []);
  useLayoutEffect(() => {
    if (host && !sheet) desktopHost.current?.appendChild(host);
  }, [host, sheet]);
  const restoreFocus = useCallback(() => {
    const back = opener.current ?? selected;
    opener.current = null;
    requestAnimationFrame(() => {
      const row = back && rootRef.current?.querySelector<HTMLElement>(`[data-select-item="${CSS.escape(back)}"]`);
      const fallback = rootRef.current?.querySelector<HTMLElement>("input, [data-select-item]");
      (row && row.getClientRects().length > 0 ? row : (fallback ?? rootRef.current))?.focus();
    });
  }, [selected]);

  const select = useCallback(
    (key: string | null) => {
      const next = key !== null && valid(key) ? key : null;
      setChosen(next);
      const url = new URL(window.location.href);
      if (next === null) url.searchParams.delete(ITEM_PARAM);
      else url.searchParams.set(ITEM_PARAM, next);
      if (detailPanel && selected === null && next !== null) {
        window.history.pushState(window.history.state, "", url);
      } else {
        window.history.replaceState(window.history.state, "", url);
      }
      if (next !== null) {
        opener.current = next;
        requestAnimationFrame(() => titleRef.current?.focus());
      } else if (wide) {
        restoreFocus();
      }
    },
    [valid, restoreFocus, wide, detailPanel, selected],
  );

  useEffect(() => {
    if (!detailPanel) return;
    const sync = () => {
      const key = new URL(window.location.href).searchParams.get(ITEM_PARAM);
      setChosen(key);
      if (!key) restoreFocus();
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [detailPanel, restoreFocus]);

  // Escape closes the panel, unless a dialog opened from it is the one being closed.
  useEffect(() => {
    if (selected === null || !wide || detailPanel) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const overlays = document.querySelectorAll<HTMLElement>(
        '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]',
      );
      if ([...overlays].some((overlay) => overlay.getClientRects().length > 0)) return;
      select(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, select, wide, detailPanel]);

  const shown = query ? rows.filter((row) => matchesQuery(row.search, query)) : rows;
  const current = rows.find((row) => row.key === selected) ?? null;
  const filterId = useId();
  const context = useMemo(() => ({ select, selected, panelId }), [select, selected, panelId]);

  return (
    <Context.Provider value={context}>
      <PageHeader title={title} description={description} meta={meta}>
        {actions}
      </PageHeader>
      {blockers.length > 0 && <ReadinessStrip blockers={blockers} />}
      {notices}
      <section ref={rootRef} aria-label={label} tabIndex={-1} className="grid items-start gap-4">
        <div className="@container min-w-0 space-y-3">
          {rows.length >= FILTER_FROM && (
            <div className="relative max-w-sm">
              <SearchIcon
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <label htmlFor={filterId} className="sr-only">
                Filter {label.toLowerCase()}
              </label>
              <Input
                id={filterId}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by name, provider, repository…"
                className="pl-8"
              />
            </div>
          )}
          {rows.length === 0 ? (
            empty
          ) : shown.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Nothing matches “{query}”.
            </p>
          ) : (
            <ul aria-label={label} className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
              {shown.map((row) => (
                <Row
                  key={row.key}
                  row={row}
                  panelId={panelId}
                  selected={selected === row.key}
                  onSelect={() => select(row.key)}
                  linked={detailPanel}
                />
              ))}
            </ul>
          )}
          {footer}
        </div>
        <div ref={desktopHost} className="lg:order-first" />
        <Dialog
          open={sheet}
          onOpenChange={(open) => {
            if (!open) select(null);
          }}
        >
          <DialogPortal>
            <DialogOverlay />
            <DialogPrimitive.Content
              aria-labelledby={titleId}
              aria-describedby={undefined}
              className={detailPanel
                ? "fixed inset-y-0 right-0 z-50 w-full outline-none sm:max-w-xl data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right motion-reduce:animate-none"
                : "fixed inset-x-0 top-[8dvh] bottom-0 z-50 outline-none"}
              ref={(node) => {
                if (node && host) node.appendChild(host);
              }}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                titleRef.current?.focus();
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                // Resizing is not closing the selected resource.
                if (detailPanel || !readWide()) restoreFocus();
              }}
            />
          </DialogPortal>
        </Dialog>
        {host &&
          createPortal(
            <aside
              id={panelId}
              data-resource-panel
              aria-labelledby={titleId}
              hidden={selected === null}
              className={detailPanel
                ? "flex h-dvh flex-col overflow-hidden border-l bg-background shadow-2xl"
                : "fixed inset-x-0 top-[8dvh] bottom-0 z-50 flex flex-col overflow-hidden rounded-t-2xl border bg-background shadow-2xl lg:static lg:order-first lg:z-auto lg:max-h-[65dvh] lg:rounded-xl lg:bg-card lg:shadow-xs"}
            >
              <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
                <div className="min-w-0 space-y-0.5">
                  <h2
                    id={titleId}
                    data-resource-panel-title
                    ref={titleRef}
                    tabIndex={-1}
                    className="truncate text-base font-semibold tracking-tight outline-none"
                  >
                    {current?.name}
                  </h2>
                  {current?.subtitle && <div className="text-xs text-muted-foreground">{current.subtitle}</div>}
                </div>
                <Button variant="ghost" size="icon-sm" onClick={() => select(null)} aria-label="Close the panel">
                  <XIcon />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
                {rows.map((row) => (
                  <div key={row.key} hidden={selected !== row.key} data-panel={row.key} {...row.panelAttrs}>
                    {row.detail}
                  </div>
                ))}
              </div>
            </aside>,
            host,
          )}
      </section>
    </Context.Provider>
  );
}

function Row({
  row,
  selected,
  onSelect,
  panelId,
  linked,
}: {
  linked: boolean;
  row: ResourceRow;
  selected: boolean;
  onSelect: () => void;
  panelId: string;
}) {
  return (
    <li
      {...row.attrs}
      data-selected={selected || undefined}
      className={cn(
        "relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-accent/50 has-[[data-select-item]:focus-visible]:bg-accent/60 has-[[data-select-item]:focus-visible]:ring-[3px] has-[[data-select-item]:focus-visible]:ring-ring/50 has-[[data-select-item]:focus-visible]:ring-inset @xl:grid-cols-[minmax(0,1fr)_10rem_auto] @3xl:grid-cols-[minmax(0,1.4fr)_10rem_minmax(0,1fr)_auto]",
        selected && "bg-accent/70 shadow-[inset_3px_0_0_var(--color-primary)] hover:bg-accent/70",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {row.mark}
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              asChild={linked}
              onClick={(event) => {
                if (linked && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
                event.preventDefault();
                onSelect();
              }}
              aria-expanded={selected}
              aria-controls={panelId}
              data-select-item={row.key}
              className="h-auto min-w-0 shrink justify-start rounded-none p-0 text-left font-medium hover:bg-transparent dark:hover:bg-transparent motion-safe:active:not-disabled:scale-none focus-visible:ring-0 after:absolute after:inset-0 after:content-['']"
            >
              {linked ? (
                <a href={`?item=${encodeURIComponent(row.key)}`}><span className="truncate">{row.name}</span></a>
              ) : <span className="truncate">{row.name}</span>}
            </Button>
            {row.tags}
          </div>
          <div className="truncate text-xs text-muted-foreground">{row.meta}</div>
        </div>
      </div>
      <div className="col-start-1 row-start-2 min-w-0 @xl:col-start-auto @xl:row-start-auto">{row.state}</div>
      <div className="hidden min-w-0 truncate text-sm text-muted-foreground @3xl:block">{row.fact}</div>
      <div className="relative z-10 col-start-2 row-span-2 row-start-1 flex justify-end @xl:col-start-auto @xl:row-span-1 @xl:row-start-auto">
        {row.action}
      </div>
    </li>
  );
}

/** What blocks launching, each a link to its fix. The page leaves it out when nothing blocks. */
function ReadinessStrip({ blockers }: { blockers: Blocker[] }) {
  const { select } = useBrowser();
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-readiness
      className="flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 sm:flex-row sm:items-center"
    >
      <h2 id={titleId} className="flex shrink-0 items-center gap-2 text-sm font-medium">
        <TriangleAlertIcon aria-hidden className="size-4 text-warning" />
        {blockers.length === 1 ? "1 item needs attention" : `${blockers.length} items need attention`}
      </h2>
      <ul className="flex flex-wrap gap-2">
        {blockers.map((blocker) => (
          <li key={blocker.key} data-blocker={blocker.key}>
            {"href" in blocker.target ? (
              <BlockerLink title={blocker.detail} asChild>
                <Link href={blocker.target.href}>
                  {blocker.label}
                  <span className="sr-only">. {blocker.detail}</span>
                </Link>
              </BlockerLink>
            ) : (
              <BlockerLink title={blocker.detail} asChild>
                <a
                  href={`?${ITEM_PARAM}=${encodeURIComponent(blocker.target.item)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    if ("item" in blocker.target) select(blocker.target.item);
                  }}
                >
                  {blocker.label}
                  <span className="sr-only">. {blocker.detail}</span>
                </a>
              </BlockerLink>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function BlockerLink(props: ComponentProps<typeof Button>) {
  return <Button variant="outline" size="sm" className="h-7 bg-background" {...props} />;
}

/** A button that opens a row's panel (a row action whose fix lives there, a pointer to another row). */
export function SelectItem({ item, ...props }: { item: string } & Omit<ComponentProps<typeof Button>, "onClick">) {
  const { select, panelId } = useBrowser();
  return <Button {...props} onClick={() => select(item)} aria-controls={panelId} />;
}

const WIDE = "(min-width: 64rem)";
function subscribeWide(change: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}
const readWide = () => window.matchMedia(WIDE).matches;

/** Focus handoffs from nested dialogs must target the current visible frame, never a retained route's ID. */
export function visibleResourcePanelTitle(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("[data-resource-panel-title]")].find(
    (title) => title.getClientRects().length > 0,
  );
}
