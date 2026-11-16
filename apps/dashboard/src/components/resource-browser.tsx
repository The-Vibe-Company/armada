"use client";

import { ChevronDownIcon, ChevronUpIcon, SearchIcon, TriangleAlertIcon, XIcon } from "lucide-react";
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
} from "react";
import { createPortal } from "react-dom";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  clearResourceReturnFocus,
  ownsResourceDetail,
  pushResourceDetail,
  replaceResourceUrl,
  resourceReturnFocus,
  syncResourceHistory,
} from "@/lib/resource-history";
import { type Blocker, FILTER_FROM, ITEM_PARAM, matchesQuery } from "@/lib/resource-list";
import { cn } from "@/lib/utils";

/**
 * The skeleton every Build page shares (#808): the readiness strip on top, one dense list (a row per item, its
 * state and its one expected action). Selecting a row opens its detail in a modal right-hand panel over the list
 * (#1153): full screen on a phone, `?item=` in the URL, Back, Escape, the close button or a click outside close it,
 * and focus returns to the row. A page's create flow is a `CreateDialog` passed as `actions` (#896, #898), never this
 * panel. The page renders each row's cells and panel on the server; this component only chooses which panel shows.
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
  catalog?: { group?: string | undefined; attention?: boolean; version?: string; body?: ReactNode; footer?: ReactNode };
  filters?: string[];
  columns?: { key: string; content: ReactNode }[];
  /** Small tags beside the name (Personal, Org, Private). */
  tags?: ReactNode;
  /** One line under the name: provider · scope · age. */
  meta: ReactNode;
  state: ReactNode;
  /** The useful fact: the repositories of an environment, the identity and tool count of a tool. */
  fact?: ReactNode;
  /** The one expected action, as a button. Stays above the row's select target. */
  action?: ReactNode;
  foot?: ReactNode;
  /** The panel's subtitle under the name. */
  subtitle?: ReactNode;
  detail: ReactNode;
  /** `data-*` attributes of the row and of its panel, for tests and styling. */
  attrs?: Record<string, string>;
  panelAttrs?: Record<string, string>;
};

type BrowserContext = {
  select: (key: string | null) => void;
  selected: string | null;
  panelId: string;
  selectionQuery: string;
};
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
  selectionQuery = "",
  filters,
  catalogFilters,
  searchPlaceholder,
  columns,
}: {
  title: string;
  description: string;
  catalogFilters?: { key: string; label: string }[] | undefined;
  filters?: { key: string; label: string }[];
  searchPlaceholder?: string;
  columns?: string[];
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
  /** Scope retained by native open-in-new-tab selection links. */
  selectionQuery?: string;
}) {
  const keys = useMemo(() => new Set(rows.map((row) => row.key)), [rows]);
  const valid = useCallback((key: string | null) => key !== null && keys.has(key), [keys]);
  const [chosen, setChosen] = useState<string | null>(initial);
  // A row removed by an action, or a stale link, closes the panel rather than showing nothing.
  const selected = chosen !== null && valid(chosen) ? chosen : null;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const browserId = useId();
  const panelId = `${browserId}-panel`;
  const titleId = `${browserId}-panel-title`;
  const rootRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<string | null>(null);
  const open = selected !== null;
  useEffect(() => {
    if (selected !== null) opener.current = selected;
  }, [selected]);
  // The portal target never changes. Parking this host while the panel is closed, rather than changing React
  // parents, retains every detail form and build follower across closing and reopening.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const parking = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    setHost(document.createElement("div"));
  }, []);
  useLayoutEffect(() => {
    if (host && !open) parking.current?.appendChild(host);
  }, [host, open]);
  const restoreFocus = useCallback(() => {
    const back = opener.current ?? selected;
    opener.current = null;
    requestAnimationFrame(() => {
      const row = back && rootRef.current?.querySelector<HTMLElement>(`[data-select-item="${CSS.escape(back)}"]`);
      // Deleting a row may intentionally focus a page action (for example Add).
      // Do not overwrite that valid handoff with our missing-row fallback.
      const active = document.activeElement;
      if (
        back &&
        !row &&
        active instanceof HTMLElement &&
        active !== document.body &&
        active.getClientRects().length > 0 &&
        !rootRef.current?.contains(active)
      )
        return;
      const fallback = rootRef.current?.querySelector<HTMLElement>("input, [data-select-item]");
      (row && row.getClientRects().length > 0 ? row : (fallback ?? rootRef.current))?.focus();
    });
  }, [selected]);

  // Native Back can replace this component after Radix has restored the old
  // tree's focus. The destination entry owns the target, not the closing tree.
  const returnedRow = useRef<HTMLElement | null>(null);
  const restoreHistoryFocus = useCallback(() => {
    if (selected !== null) return;
    const key = resourceReturnFocus();
    const row = key && rootRef.current?.querySelector<HTMLElement>(`[data-select-item="${CSS.escape(key)}"]`);
    if (!row || row.getClientRects().length === 0) return;
    if (returnedRow.current !== row || document.activeElement === document.body) row.focus();
    returnedRow.current = row;
  }, [selected]);
  // Re-run for a new destination tree; the post-commit frame also follows the
  // old FocusScope cleanup. Never keep forcing focus after user interaction.
  useLayoutEffect(restoreHistoryFocus);
  useEffect(() => {
    const frame = requestAnimationFrame(restoreHistoryFocus);
    return () => cancelAnimationFrame(frame);
  });
  useEffect(() => {
    document.addEventListener("pointerdown", clearResourceReturnFocus, true);
    document.addEventListener("keydown", clearResourceReturnFocus, true);
    return () => {
      document.removeEventListener("pointerdown", clearResourceReturnFocus, true);
      document.removeEventListener("keydown", clearResourceReturnFocus, true);
    };
  }, []);

  const select = useCallback(
    (key: string | null) => {
      const next = key !== null && valid(key) ? key : null;
      // Keep only our marker, not Next's private history fields: passing __NA
      // would bypass its native-history URL synchronization.
      const owned = ownsResourceDetail();
      if (next === null && owned) {
        window.history.back();
        return; // popstate closes the sheet and Radix restores focus once.
      }
      setChosen(next);
      const url = new URL(window.location.href);
      if (next === null) url.searchParams.delete(ITEM_PARAM);
      else url.searchParams.set(ITEM_PARAM, next);
      if (selected === null && next !== null) {
        pushResourceDetail(url);
      } else {
        replaceResourceUrl(url);
      }
      if (next !== null) {
        opener.current = next;
        requestAnimationFrame(() => titleRef.current?.focus());
      }
    },
    [valid, selected],
  );

  useEffect(() => {
    const reconcile = () => setChosen(new URL(window.location.href).searchParams.get(ITEM_PARAM));
    const sync = () => {
      syncResourceHistory();
      reconcile();
    };
    window.addEventListener("popstate", sync);
    // Back may precede hydration/subscription, or resume a retained route tree.
    // Initial props are not authoritative once native history has moved.
    reconcile();
    // Child effects run before the router's on a first mount. Write history only
    // after the router has patched it and replayed a missed Back, so the entry
    // keeps the router's own state and the next dismissal stays in this document.
    let live = true;
    queueMicrotask(() => {
      if (live) syncResourceHistory();
    });
    return () => {
      live = false;
      window.removeEventListener("popstate", sync);
    };
  }, []);

  const inCategory = (row: ResourceRow, key: string) =>
    key === "all" || (key === "attention" ? row.catalog?.attention : row.catalog?.group === key);
  const tabs = catalogFilters ?? (filters ? [{ key: "all", label: "All" }, ...filters] : undefined);
  const matchesFilter = (row: ResourceRow, key: string) =>
    catalogFilters ? inCategory(row, key) : key === "all" || row.filters?.includes(key);
  const shown = rows.filter((row) => (!query || matchesQuery(row.search, query)) && matchesFilter(row, filter));
  const current = rows.find((row) => row.key === selected) ?? null;
  const currentIndex = shown.findIndex((row) => row.key === selected);
  const move = (delta: number) => {
    const next = currentIndex >= 0 ? shown[currentIndex + delta] : undefined;
    if (next) select(next.key);
  };
  const filterId = useId();
  const context = useMemo(
    () => ({ select, selected, panelId, selectionQuery }),
    [select, selected, panelId, selectionQuery],
  );

  return (
    <Context.Provider value={context}>
      <PageHeader
        title={title}
        description={filters || columns ? undefined : description}
        meta={meta}
        inlineActions={Boolean(tabs || columns)}
      >
        {actions}
      </PageHeader>
      {blockers.length > 0 && <ReadinessStrip blockers={blockers} />}
      {notices}
      <section ref={rootRef} aria-label={label} tabIndex={-1} className="grid items-start gap-4">
        <div className="@container min-w-0 space-y-3">
          {(tabs || searchPlaceholder || rows.length >= FILTER_FROM) && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              {tabs && (
                <fieldset
                  aria-label={`Filter ${label.toLowerCase()}`}
                  className="inline-flex flex-wrap gap-0.5 rounded-lg bg-muted p-[3px]"
                >
                  {tabs.map((item) => (
                    <Button
                      key={item.key}
                      variant="ghost"
                      size="sm"
                      aria-pressed={filter === item.key}
                      onClick={() => setFilter(item.key)}
                      className={cn("h-7 gap-1.5 px-2.5 text-[13px]", filter === item.key && "bg-card shadow-xs")}
                    >
                      {item.label}
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {rows.filter((row) => matchesFilter(row, item.key)).length}
                      </span>
                    </Button>
                  ))}
                </fieldset>
              )}
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
                  placeholder={
                    searchPlaceholder ??
                    (catalogFilters
                      ? title === "Snapshots"
                        ? "Search snapshots or repositories"
                        : "Search templates"
                      : "Filter by name, provider, repository…")
                  }
                  className="h-[34px] pl-8 text-[13px]"
                />
              </div>
            </div>
          )}
          {rows.length === 0 ? (
            empty
          ) : shown.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Nothing matches “{query}”.
              {tabs && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mx-auto mt-3 block"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </p>
          ) : columns ? (
            <div className="overflow-x-auto rounded-[10px] border bg-card">
              <table aria-label={label} className="w-full min-w-[760px] table-fixed text-left">
                <thead className="bg-muted text-xs text-muted-foreground">
                  <tr>
                    {columns.map((column) => (
                      <th key={column} scope="col" className="px-4 py-2 font-normal">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => (
                    <Row
                      key={row.key}
                      row={row}
                      panelId={panelId}
                      selected={selected === row.key}
                      onSelect={() => select(row.key)}
                      table
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul
              aria-label={label}
              className="grid grid-cols-1 gap-x-4 divide-y overflow-hidden rounded-xl border bg-card shadow-xs @xl:grid-cols-[minmax(0,1fr)_10rem_auto] @3xl:grid-cols-[minmax(0,1fr)_10rem_fit-content(12rem)_auto]"
            >
              {shown.map((row) => (
                <Row
                  key={row.key}
                  row={row}
                  catalog={!!catalogFilters}
                  panelId={panelId}
                  selected={selected === row.key}
                  onSelect={() => select(row.key)}
                />
              ))}
            </ul>
          )}
          {footer}
        </div>
        <div ref={parking} hidden />
        <Dialog
          open={open}
          onOpenChange={(open) => {
            if (!open) select(null);
          }}
        >
          <DialogPortal>
            <DialogOverlay />
            <DialogPrimitive.Content
              aria-labelledby={titleId}
              aria-describedby={undefined}
              className="fixed inset-y-0 right-0 z-50 w-full outline-none sm:max-w-xl data-[state=open]:animate-in data-[state=open]:slide-in-from-right motion-reduce:animate-none"
              ref={(node) => {
                if (node && host) node.appendChild(host);
              }}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                titleRef.current?.focus();
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                restoreFocus();
              }}
            />
          </DialogPortal>
        </Dialog>
        {host &&
          createPortal(
            <aside
              id={panelId}
              data-catalog-panel={!!catalogFilters || undefined}
              data-resource-panel
              onKeyDown={(event) => {
                if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                const target = event.target as HTMLElement;
                if (
                  target.closest(
                    "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=combobox]",
                  )
                )
                  return;
                const surface = target.closest(
                  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
                );
                if (surface !== titleRef.current?.closest('[role="dialog"]')) return;
                const delta =
                  event.key === "ArrowDown" || event.key === "j"
                    ? 1
                    : event.key === "ArrowUp" || event.key === "k"
                      ? -1
                      : 0;
                if (delta) {
                  event.preventDefault();
                  move(delta);
                }
              }}
              aria-labelledby={titleId}
              hidden={selected === null}
              className="flex h-dvh flex-col overflow-hidden border-l bg-background shadow-2xl"
            >
              <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
                {catalogFilters && current?.mark}
                <div className="min-w-0 space-y-0.5">
                  <h2
                    id={titleId}
                    data-resource-panel-title
                    ref={titleRef}
                    tabIndex={-1}
                    className="break-words text-base font-semibold tracking-tight outline-none"
                  >
                    {current?.name}
                  </h2>
                  {current?.subtitle && <div className="text-xs text-muted-foreground">{current.subtitle}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Previous item"
                    title="Previous item (↑ or K)"
                    disabled={currentIndex <= 0}
                    onClick={() => move(-1)}
                  >
                    <ChevronUpIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Next item"
                    title="Next item (↓ or J)"
                    disabled={currentIndex < 0 || currentIndex >= shown.length - 1}
                    onClick={() => move(1)}
                  >
                    <ChevronDownIcon />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => select(null)} aria-label="Close the panel">
                    <XIcon />
                  </Button>
                </div>
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
  table = false,
  catalog = false,
  row,
  selected,
  onSelect,
  panelId,
}: {
  row: ResourceRow;
  table?: boolean;
  catalog?: boolean;
  selected: boolean;
  onSelect: () => void;
  panelId: string;
}) {
  const { selectionQuery } = useBrowser();
  const Container = table ? "tr" : "li";
  const Cell = table ? "td" : "div";
  return (
    <Container
      {...row.attrs}
      data-selected={selected || undefined}
      className={cn(
        // From @xl the list owns the column tracks and every row shares them (subgrid), so a wider action in one
        // row does not shift the state and fact columns of the others (a row without one keeps that column empty).
        // On phones actions follow the name and state; wider rows can share space without squeezing long names.
        "relative col-span-full grid grid-cols-1 items-center @sm:grid-cols-[minmax(0,1fr)_auto] @xl:grid-cols-subgrid gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-accent/50 has-[[data-select-item]:focus-visible]:bg-accent/60 has-[[data-select-item]:focus-visible]:ring-[3px] has-[[data-select-item]:focus-visible]:ring-ring/50 has-[[data-select-item]:focus-visible]:ring-inset",
        table && "!table-row border-t",
        selected && "bg-accent/70 shadow-[inset_3px_0_0_var(--color-primary)] hover:bg-accent/70",
      )}
    >
      <Cell className={cn("min-w-0", table ? "px-4 py-[9px]" : "flex items-center gap-3")}>
        {row.mark}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              asChild
              onClick={(event) => {
                // A modified click keeps the browser's own behaviour: a new tab or window on the `?item=` link.
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onSelect();
              }}
              aria-expanded={selected}
              aria-controls={panelId}
              data-select-item={row.key}
              className="h-auto min-w-0 shrink justify-start rounded-none p-0 text-left font-medium hover:bg-transparent dark:hover:bg-transparent motion-safe:active:not-disabled:scale-none focus-visible:ring-0 after:absolute after:inset-0 after:content-['']"
            >
              <a href={`?${selectionQuery ? `${selectionQuery}&` : ""}item=${encodeURIComponent(row.key)}`}>
                <span title={row.name} className="min-w-0 whitespace-normal break-words sm:truncate">
                  {row.name}
                </span>
              </a>
            </Button>
            {catalog && row.catalog?.version && (
              <span className="font-mono text-xs text-muted-foreground">{row.catalog.version}</span>
            )}
            {!catalog && row.tags}
          </div>
          <div
            title={typeof row.meta === "string" ? row.meta : undefined}
            className="truncate text-xs text-muted-foreground"
          >
            {row.meta}
          </div>
        </div>
      </Cell>
      {row.columns ? (
        row.columns.map((cell) => (
          <Cell key={cell.key} className="min-w-0 px-4 py-[9px] text-[13px] text-muted-foreground">
            {cell.content}
          </Cell>
        ))
      ) : (
        <>
          <div
            data-catalog-status={catalog || undefined}
            className="col-start-1 row-start-2 min-w-0 @xl:col-start-auto @xl:row-start-auto"
          >
            {row.state}
          </div>
          {catalog && (
            <div data-catalog-body className="space-y-3">
              {row.catalog?.body}
              {row.fact}
            </div>
          )}
          <div className="hidden min-w-0 truncate text-sm text-muted-foreground @3xl:block">{!catalog && row.fact}</div>
          <div className="relative z-10 col-start-1 row-start-3 flex justify-start @sm:col-start-2 @sm:row-span-2 @sm:row-start-1 @sm:justify-end @xl:col-start-auto @xl:row-span-1 @xl:row-start-auto">
            {(row.foot || row.catalog?.footer) && (
              <span className="mr-auto min-w-0 truncate text-xs text-muted-foreground">
                {row.foot ?? row.catalog?.footer}
              </span>
            )}
            {row.action ??
              (catalog && (
                <Button variant="outline" size="sm" onClick={onSelect}>
                  {row.catalog?.attention ? "See why" : "Details"}
                </Button>
              ))}
          </div>
        </>
      )}
    </Container>
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
export function SelectItem({
  item,
  className,
  ...props
}: { item: string } & Omit<ComponentProps<typeof Button>, "onClick">) {
  const { select, panelId } = useBrowser();
  return (
    <Button
      {...props}
      className={cn("relative z-10", className)}
      onClick={() => select(item)}
      aria-controls={panelId}
    />
  );
}

/** Focus handoffs from nested dialogs must target the current visible frame, never a retained route's ID. */
export function visibleResourcePanelTitle(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("[data-resource-panel-title]")].find(
    (title) => title.getClientRects().length > 0,
  );
}
