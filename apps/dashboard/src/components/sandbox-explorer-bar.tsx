"use client";

import {
  ArrowLeftIcon,
  ArrowUpDownIcon,
  CheckIcon,
  ChevronRightIcon,
  ListFilterIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { SandboxActivity } from "@/lib/sandbox-activity";
import {
  type Facet,
  type FacetOption,
  filtersToSearch,
  parseSandboxFilters,
  type SandboxFilters,
} from "@/lib/sandbox-filters";
import { shouldIgnoreGlobalShortcut } from "@/lib/shortcut";
import { cn } from "@/lib/utils";

const FACETS_ORDER: readonly Facet[] = ["status", "harness", "provider", "model", "owner", "size"];
const LABELS: Record<Facet, string> = {
  status: "Status",
  harness: "Agent",
  provider: "Provider",
  model: "Model",
  owner: "Owner",
  size: "Size",
};
const STATES: readonly [SandboxActivity, string][] = [
  ["all", "All"],
  ["active", "Active"],
  ["need", "Waiting"],
  ["stopped", "Stopped"],
  ["failed", "Failed"],
];
const SORTS: readonly [SandboxFilters["sort"], string][] = [
  ["newest", "Newest"],
  ["attention", "Attention"],
  ["oldest", "Oldest"],
  ["name", "Name"],
];
const GROUP = "inline-flex h-9 min-w-0 shrink-0 items-center rounded-lg border bg-[var(--sunken)] p-1";
const SEG =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap outline-none transition-[color,background-color,box-shadow] duration-120 ease-(--ease-out) motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring";
const ACTIVE = "bg-[var(--surface)] text-foreground shadow-xs ring-1 ring-border/70";
const IDLE = "text-muted-foreground fine-hover:text-foreground";
const CHIP =
  "inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md border bg-[var(--surface)] px-2 text-xs font-medium text-foreground shadow-xs outline-none fine-hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

function buildHref(filters: SandboxFilters, activity: SandboxActivity) {
  const params = new URLSearchParams(filtersToSearch(filters));
  if (activity !== "all") params.set("activity", activity);
  return params.size ? `/sandboxes?${params}` : "/sandboxes";
}

export function SandboxExplorerBar({
  filters,
  activity,
  counts,
  options,
  deletedCount,
  workingCount,
  waitingCount,
  showScopeToggle,
}: {
  filters: SandboxFilters;
  activity: SandboxActivity;
  counts: Record<SandboxActivity, number>;
  options: Record<Facet, FacetOption[]>;
  deletedCount: number;
  workingCount: number;
  waitingCount: number;
  showScopeToggle: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(filters);
  const [tab, setTab] = useState(activity);
  const [query, setQuery] = useState(filters.q);
  const [filterOpen, setFilterOpen] = useState(false);
  const [facet, setFacet] = useState<Facet | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [pending, startTransition] = useTransition();
  const [showPending, setShowPending] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);
  const latestRef = useRef({ current, tab });
  latestRef.current = { current, tab };

  const stopDebounce = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => {
    stopDebounce();
    setCurrent(filters);
    setTab(activity);
    setQuery(filters.q);
  }, [filters, activity, stopDebounce]);

  useEffect(() => stopDebounce, [stopDebounce]);

  useEffect(() => {
    if (!pending) return setShowPending(false);
    const id = window.setTimeout(() => setShowPending(true), 120);
    return () => window.clearTimeout(id);
  }, [pending]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "/" && !shouldIgnoreGlobalShortcut(event, { allowShift: true })) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key.toLowerCase() === "f" && !shouldIgnoreGlobalShortcut(event)) {
        event.preventDefault();
        setFilterOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const navigate = useCallback(
    (next: SandboxFilters, nextTab: SandboxActivity, mode: "push" | "replace" = "push") => {
      stopDebounce();
      setCurrent(next);
      setTab(nextTab);
      const href = buildHref(next, nextTab);
      startTransition(() => (mode === "replace" ? router.replace : router.push)(href, { scroll: false }));
    },
    [stopDebounce, router],
  );

  function toggleFacet(key: Facet, value: string) {
    const add = !current[key].includes(value);
    const values = add ? [...current[key], value] : current[key].filter((v) => v !== value);
    navigate({ ...current, [key]: values, page: 1 }, key === "status" && value === "deleted" && add ? "all" : tab);
  }

  function onSearchChange(next: string) {
    setQuery(next);
    stopDebounce();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const q = next.trim();
      const latest = latestRef.current;
      if (q !== latest.current.q) navigate({ ...latest.current, q, page: 1 }, latest.tab, "replace");
    }, 220);
  }

  function clearSearch(blur = false) {
    stopDebounce();
    setQuery("");
    if (current.q) navigate({ ...current, q: "", page: 1 }, tab, "replace");
    if (blur) searchRef.current?.blur();
  }

  const showOpt = (k: Facet, v: string) =>
    !(k === "status" && v === "deleted") && !(k === "owner" && showScopeToggle && v === "me");
  const isMine = current.owner.includes("me");
  const deletedOn = current.status.includes("deleted");
  const chips = FACETS_ORDER.flatMap((key) =>
    current[key]
      .filter((v) => !(key === "owner" && showScopeToggle && v === "me"))
      .map((value) => ({ key, value, label: options[key].find((item) => item.value === value)?.label ?? value })),
  );
  const sortLabel = SORTS.find(([v]) => v === current.sort)?.[1] ?? "Newest";
  const needle = filterQuery.trim().toLocaleLowerCase();
  const match = (opt: FacetOption) =>
    !needle || opt.label.toLocaleLowerCase().includes(needle) || opt.value.toLocaleLowerCase().includes(needle);
  const groups = facet
    ? [
        {
          key: facet,
          heading: facet === "owner" ? "Everyone in this organization" : LABELS[facet],
          items: options[facet].filter((o) => showOpt(facet, o.value) && match(o)),
        },
      ]
    : needle
      ? FACETS_ORDER.map((k) => ({
          key: k,
          heading: LABELS[k],
          items: options[k].filter(
            (o) => showOpt(k, o.value) && (LABELS[k].toLocaleLowerCase().includes(needle) || match(o)),
          ),
        })).filter((g) => g.items.length > 0)
      : [];
  const showDeletedSearch = !facet && Boolean(needle) && "deleted sandboxes".includes(needle);

  return (
    <section
      aria-label="Filters"
      aria-busy={pending}
      data-pending={showPending ? "" : undefined}
      className="peer min-w-0 space-y-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        {showScopeToggle && (
          <fieldset aria-label="Sandbox scope" className={GROUP}>
            {(
              [
                ["Everyone", false],
                ["Mine", true],
              ] as const
            ).map(([label, mine]) => {
              const pressed = mine ? isMine : !isMine;
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() =>
                    navigate(
                      { ...current, owner: mine ? ["me"] : current.owner.filter((v) => v !== "me"), page: 1 },
                      tab,
                    )
                  }
                  className={cn(SEG, pressed ? ACTIVE : IDLE)}
                >
                  {label}
                </button>
              );
            })}
          </fieldset>
        )}

        <fieldset aria-label="Sandbox state" className={cn(GROUP, "max-w-full shrink overflow-x-auto")}>
          {STATES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => navigate({ ...current, page: 1 }, id)}
              className={cn(SEG, tab === id ? ACTIVE : IDLE)}
            >
              {id === "active" && workingCount > 0 && (
                <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
              )}
              {id === "need" && waitingCount > 0 && (
                <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
              )}
              <span>{label}</span>
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{counts[id]}</span>
            </button>
          ))}
        </fieldset>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <div className="relative min-w-[160px] flex-1 sm:max-w-[260px]">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchRef}
              type="text"
              role="searchbox"
              aria-label="Search sandboxes"
              placeholder="Search sandboxes…"
              value={query}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  clearSearch(true);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const q = query.trim();
                  if (q !== current.q) navigate({ ...current, q, page: 1 }, tab, "replace");
                }
              }}
              className="h-9 pr-9 pl-8 text-[13px]"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => clearSearch(false)}
                className="absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground outline-none fine-hover:bg-accent fine-hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <XIcon className="size-3.5" />
              </button>
            ) : (
              <Kbd
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 sm:inline-flex"
              >
                /
              </Kbd>
            )}
          </div>

          <Popover
            open={filterOpen}
            onOpenChange={(next) => {
              setFilterOpen(next);
              if (!next) {
                setFacet(null);
                setFilterQuery("");
              }
            }}
          >
            <PopoverTrigger asChild>
              <Button variant="outline" className="h-9 gap-1.5 px-2.5" aria-label="Filter sandboxes">
                <ListFilterIcon className="size-3.5" aria-hidden="true" />
                <span>Filter</span>
                {chips.length > 0 ? (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-sm bg-secondary px-1 font-mono text-[11px] font-medium text-foreground tabular-nums">
                    {chips.length}
                  </span>
                ) : (
                  <Kbd aria-hidden="true" className="hidden sm:inline-flex">
                    F
                  </Kbd>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" aria-label="Sandbox filters" className="w-[272px] p-0">
              <Command label="Filter sandboxes" shouldFilter={false}>
                {facet && (
                  <div className="flex items-center gap-1 border-b px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setFacet(null);
                        setFilterQuery("");
                      }}
                      className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs font-medium text-muted-foreground outline-none fine-hover:bg-accent fine-hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
                      Back
                    </button>
                    <span className="ml-auto pr-1 text-xs font-medium text-foreground">{LABELS[facet]}</span>
                  </div>
                )}
                <CommandInput
                  autoFocus
                  placeholder={facet ? `Find ${LABELS[facet].toLowerCase()}…` : "Filter by facet or value…"}
                  value={filterQuery}
                  onValueChange={setFilterQuery}
                  onKeyDown={(e) => {
                    if (e.key === "Backspace" && !filterQuery && facet) {
                      e.preventDefault();
                      setFacet(null);
                    }
                  }}
                  className="h-9"
                />
                <CommandList>
                  {facet || needle ? (
                    groups.some((g) => g.items.length > 0) || showDeletedSearch ? (
                      <>
                        {groups.map(({ key, heading, items }) =>
                          items.length ? (
                            <CommandGroup key={key} heading={heading}>
                              {items.map((opt) => (
                                <OptionItem
                                  key={`${key}:${opt.value}`}
                                  facet={key}
                                  option={opt}
                                  checked={current[key].includes(opt.value)}
                                  onSelect={() => toggleFacet(key, opt.value)}
                                />
                              ))}
                            </CommandGroup>
                          ) : null,
                        )}
                        {showDeletedSearch && (
                          <CommandGroup heading="Archive">
                            <DeletedItem
                              checked={deletedOn}
                              count={deletedCount}
                              onSelect={() => toggleFacet("status", "deleted")}
                            />
                          </CommandGroup>
                        )}
                      </>
                    ) : (
                      <CommandEmpty>No options found.</CommandEmpty>
                    )
                  ) : (
                    <>
                      <CommandGroup>
                        {FACETS_ORDER.map((k) => {
                          const n = current[k].filter((v) => showOpt(k, v)).length;
                          return (
                            <CommandItem
                              key={k}
                              value={LABELS[k]}
                              onSelect={() => {
                                setFacet(k);
                                setFilterQuery("");
                              }}
                              className="cursor-pointer justify-between"
                            >
                              <span>{LABELS[k]}</span>
                              <span className="flex items-center gap-1.5">
                                {n > 0 && (
                                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-sm bg-secondary px-1 font-mono text-[11px] tabular-nums">
                                    {n}
                                  </span>
                                )}
                                <ChevronRightIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                              </span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                      <hr className="my-1 border-0 border-t border-border" />
                      <CommandGroup>
                        <DeletedItem
                          checked={deletedOn}
                          count={deletedCount}
                          onSelect={() => toggleFacet("status", "deleted")}
                        />
                      </CommandGroup>
                    </>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-9 gap-1.5 px-2.5" aria-label={`Sort: ${sortLabel}`}>
                <ArrowUpDownIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="hidden sm:inline">{sortLabel}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              {SORTS.map(([value, label]) => (
                <DropdownMenuItem key={value} onSelect={() => navigate({ ...current, sort: value, page: 1 }, tab)}>
                  <span className="flex-1">{label}</span>
                  {current.sort === value && <CheckIcon className="size-3.5" aria-hidden="true" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {(current.q || chips.length > 0) && (
        <section className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
          {current.q && (
            <button
              type="button"
              aria-label={`Remove search: ${current.q}`}
              onClick={() => clearSearch(false)}
              className={CHIP}
            >
              <span className="truncate">Search: {current.q}</span>
              <XIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          )}
          {chips.map(({ key, value, label }) => (
            <button
              key={`${key}:${value}`}
              type="button"
              aria-label={`Remove ${LABELS[key]}: ${label}`}
              onClick={() => toggleFacet(key, value)}
              className={CHIP}
            >
              <span className="truncate">
                <span className="text-muted-foreground">{LABELS[key]}:</span> {label}
              </span>
              <XIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          ))}
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() =>
              navigate(
                parseSandboxFilters({ sort: current.sort, ...(showScopeToggle && isMine ? { owner: "me" } : {}) }),
                tab,
              )
            }
          >
            Clear all
          </Button>
        </section>
      )}
      <p className="sr-only" role="status">
        {pending ? "Updating sandboxes" : "Sandboxes updated"}
      </p>
    </section>
  );
}

function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-sm border",
        checked && "border-foreground bg-foreground text-background",
      )}
    >
      {checked && <CheckIcon className="size-3" />}
    </span>
  );
}

function OptionItem({
  facet,
  option,
  checked,
  onSelect,
}: {
  facet: Facet;
  option: FacetOption;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={`${facet}:${option.value} ${option.label}`} onSelect={onSelect} className="cursor-pointer">
      <CheckBox checked={checked} />
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      <span className="sr-only">{checked ? "Filter applied" : "Filter not applied"}</span>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{option.count}</span>
    </CommandItem>
  );
}

function DeletedItem({ checked, count, onSelect }: { checked: boolean; count: number; onSelect: () => void }) {
  return (
    <CommandItem value="Deleted sandboxes" onSelect={onSelect} className="cursor-pointer">
      <CheckBox checked={checked} />
      <Trash2Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">Deleted sandboxes</span>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">({count})</span>
    </CommandItem>
  );
}
