"use client";

import { ArrowLeftIcon, PlusIcon, SearchIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import Link from "next/link";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type Blocker, FILTER_FROM, ITEM_PARAM, matchesQuery, NEW_ITEM } from "@/lib/resource-list";
import { cn } from "@/lib/utils";

/**
 * The skeleton every Build page shares (#808): the readiness strip on top, one dense list (a row per item, its
 * state and its one expected action), a detail panel on the right for everything rare (a sheet on a phone), and
 * one New button that opens the create form in that same panel. A page whose create form is long asks for a create
 * page instead (`layout: "page"`, Environments since #898): the form alone at a readable width, in place of the list,
 * with a way back. The page renders each row's cells and panel on the server; this component only chooses what shows.
 *
 * Every panel and the create page stay mounted, hidden when not selected: a form that follows a build keeps its
 * state while the person looks at another row.
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

type BrowserContext = { select: (key: string | null) => void; selected: string | null };
const Context = createContext<BrowserContext | null>(null);

function useBrowser(): BrowserContext {
  const value = useContext(Context);
  if (!value) throw new Error("outside a ResourceBrowser");
  return value;
}

export function ResourceBrowser({
  title,
  description,
  meta,
  label,
  rows,
  blockers,
  notices,
  create,
  footer,
  empty,
  initial,
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
  /** The New button and the form it opens; absent when nothing can be created here. */
  create?: {
    label: string;
    title: string;
    subtitle?: ReactNode;
    content: ReactNode;
    /** `page`: a long form that replaces the list rather than squeezing it into the panel. Default `panel`. */
    layout?: "panel" | "page";
  };
  /** One quiet line under the list (the capacity). */
  footer?: ReactNode;
  empty: ReactNode;
  /** The panel open on the first render: the `?item=` of the URL, or what the page follows. */
  initial: string | null;
}) {
  const keys = useMemo(() => new Set(rows.map((row) => row.key)), [rows]);
  const valid = useCallback(
    (key: string | null) => (key === NEW_ITEM ? Boolean(create) : key !== null && keys.has(key)),
    [create, keys],
  );
  const [chosen, setChosen] = useState<string | null>(initial);
  // A row removed by an action, or a stale link, closes the panel rather than showing nothing.
  const selected = chosen !== null && valid(chosen) ? chosen : null;
  const [query, setQuery] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const createTitleRef = useRef<HTMLHeadingElement>(null);
  const pageCreate = create?.layout === "page";
  // What gets the focus back on close: what opened it; a create page open on the first render gives it to New.
  const opener = useRef<string | null>(pageCreate && initial === NEW_ITEM ? NEW_ITEM : null);

  const select = useCallback(
    (key: string | null) => {
      const next = key !== null && valid(key) ? key : null;
      setChosen(next);
      const url = new URL(window.location.href);
      if (next === null) url.searchParams.delete(ITEM_PARAM);
      else url.searchParams.set(ITEM_PARAM, next);
      window.history.replaceState(null, "", url);
      if (next !== null) {
        opener.current = next;
        requestAnimationFrame(() => (next === NEW_ITEM && pageCreate ? createTitleRef : titleRef).current?.focus());
      } else if (opener.current) {
        const back = opener.current;
        opener.current = null;
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>(`[data-select-item="${CSS.escape(back)}"]`)?.focus(),
        );
      }
    },
    [valid, pageCreate],
  );

  // Escape closes the panel or the create page, unless a dialog opened from it is the one being closed.
  useEffect(() => {
    if (selected === null) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
      if (document.querySelector('[role="menu"][data-state="open"]')) return;
      select(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, select]);

  const shown = query ? rows.filter((row) => matchesQuery(row.search, query)) : rows;
  const creating = pageCreate && selected === NEW_ITEM;
  const panelOpen = selected !== null && !creating;
  const current = selected === NEW_ITEM ? null : (rows.find((row) => row.key === selected) ?? null);
  const panelTitle = selected === NEW_ITEM ? create?.title : current?.name;
  const panelSubtitle = selected === NEW_ITEM ? create?.subtitle : current?.subtitle;
  const filterId = useId();
  const context = useMemo(() => ({ select, selected }), [select, selected]);
  // Below the lg breakpoint the panel is a sheet over the list: a modal dialog, the list behind it inert.
  const wide = useSyncExternalStore(subscribeWide, readWide, () => true);
  const sheet = panelOpen && !wide;
  const panelRef = useRef<HTMLElement>(null);
  // As a sheet, the panel is a modal dialog that keeps Tab inside; beside the list, a plain landmark.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || !sheet) return;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.addEventListener("keydown", trapFocus);
    return () => {
      panel.removeAttribute("role");
      panel.removeAttribute("aria-modal");
      panel.removeEventListener("keydown", trapFocus);
    };
  }, [sheet]);

  return (
    <Context.Provider value={context}>
      <PageHeader title={title} description={description} meta={meta}>
        {create && (
          <Button
            onClick={() => select(NEW_ITEM)}
            aria-expanded={selected === NEW_ITEM}
            aria-controls={pageCreate ? "resource-create" : "resource-panel"}
            data-select-item={NEW_ITEM}
          >
            <PlusIcon /> {create.label}
          </Button>
        )}
      </PageHeader>
      {blockers.length > 0 && <ReadinessStrip blockers={blockers} />}
      {notices}
      {create && pageCreate && (
        <section
          id="resource-create"
          aria-labelledby="resource-create-title"
          hidden={!creating}
          data-create-view
          className="mx-auto w-full max-w-4xl rounded-xl border bg-card shadow-xs"
        >
          <div className="flex items-start gap-2 border-b px-3 py-3 sm:px-4">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={() => select(null)}
              aria-label={`Back to ${label.toLowerCase()}`}
              title={`Back to ${label.toLowerCase()}`}
            >
              <ArrowLeftIcon />
            </Button>
            <div className="min-w-0 space-y-0.5 pt-0.5">
              <h2
                id="resource-create-title"
                ref={createTitleRef}
                tabIndex={-1}
                className="text-base font-semibold tracking-tight outline-none"
              >
                {create.title}
              </h2>
              {create.subtitle && <div className="text-sm text-muted-foreground">{create.subtitle}</div>}
            </div>
          </div>
          <div className="px-4 py-4 sm:px-6 sm:py-5" data-panel={NEW_ITEM}>
            {create.content}
          </div>
        </section>
      )}
      <div
        hidden={creating}
        className={cn(
          "grid items-start gap-4",
          panelOpen && "lg:grid-cols-[minmax(0,1fr)_minmax(22rem,26rem)] xl:grid-cols-[minmax(0,1fr)_28rem]",
        )}
      >
        <div className="@container min-w-0 space-y-3" inert={sheet}>
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
                <Row key={row.key} row={row} selected={selected === row.key} onSelect={() => select(row.key)} />
              ))}
            </ul>
          )}
          {footer}
        </div>
        <aside
          id="resource-panel"
          ref={panelRef}
          aria-labelledby="resource-panel-title"
          hidden={!panelOpen}
          className="fixed inset-x-0 top-[8dvh] bottom-0 z-50 flex flex-col overflow-hidden rounded-t-2xl border bg-background shadow-2xl lg:sticky lg:top-6 lg:z-auto lg:max-h-[calc(100dvh-3rem)] lg:rounded-xl lg:bg-card lg:shadow-xs"
        >
          <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
            <div className="min-w-0 space-y-0.5">
              <h2
                id="resource-panel-title"
                ref={titleRef}
                tabIndex={-1}
                className="truncate text-base font-semibold tracking-tight outline-none"
              >
                {panelTitle}
              </h2>
              {panelSubtitle && <div className="text-xs text-muted-foreground">{panelSubtitle}</div>}
            </div>
            <Button variant="ghost" size="icon-sm" onClick={() => select(null)} aria-label="Close the panel">
              <XIcon />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
            {create && !pageCreate && (
              <div hidden={selected !== NEW_ITEM} data-panel={NEW_ITEM}>
                {create.content}
              </div>
            )}
            {rows.map((row) => (
              <div key={row.key} hidden={selected !== row.key} data-panel={row.key} {...row.panelAttrs}>
                {row.detail}
              </div>
            ))}
          </div>
        </aside>
        {panelOpen && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="fixed inset-0 z-40 cursor-default bg-black/40 lg:hidden"
            onClick={() => select(null)}
          />
        )}
      </div>
    </Context.Provider>
  );
}

function Row({ row, selected, onSelect }: { row: ResourceRow; selected: boolean; onSelect: () => void }) {
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
            <button
              type="button"
              onClick={onSelect}
              aria-expanded={selected}
              aria-controls="resource-panel"
              data-select-item={row.key}
              className="min-w-0 truncate text-left font-medium outline-none after:absolute after:inset-0 after:content-['']"
            >
              {row.name}
            </button>
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
  return (
    <section
      aria-labelledby="readiness-title"
      data-readiness
      className="flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 sm:flex-row sm:items-center"
    >
      <h2 id="readiness-title" className="flex shrink-0 items-center gap-2 text-sm font-medium">
        <TriangleAlertIcon aria-hidden className="size-4 text-warning" />
        {blockers.length === 1 ? "1 thing blocks launching" : `${blockers.length} things block launching`}
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
  const { select } = useBrowser();
  return <Button {...props} onClick={() => select(item)} aria-controls="resource-panel" />;
}

const WIDE = "(min-width: 64rem)";
function subscribeWide(change: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}
const readWide = () => window.matchMedia(WIDE).matches;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Keeps Tab inside the phone sheet: past its last control back to its first, and the other way round. */
function trapFocus(event: KeyboardEvent) {
  if (event.key !== "Tab" || !(event.currentTarget instanceof HTMLElement)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (item) => item.getClientRects().length > 0,
  );
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !items.includes(active as HTMLElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
