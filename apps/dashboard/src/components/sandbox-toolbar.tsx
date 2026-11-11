"use client";

import { CheckIcon, ListFilterIcon, SearchIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  FACETS,
  type Facet,
  type FacetOption,
  filtersToSearch,
  hasSandboxFilters,
  parseSandboxFilters,
  type SandboxFilters,
} from "@/lib/sandbox-filters";

const LABELS: Record<Facet, string> = {
  status: "Status",
  provider: "Provider",
  harness: "Harness",
  model: "Model",
  owner: "Owner",
  size: "Size",
};

export function SandboxToolbar({
  filters,
  options,
}: {
  filters: SandboxFilters;
  options: Record<Facet, FacetOption[]>;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(filters);
  const [query, setQuery] = useState(filters.q);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    setCurrent(filters);
    setQuery(filters.q);
  }, [filters]);
  function navigate(next: SandboxFilters) {
    setCurrent(next);
    startTransition(() => router.push(`/sandboxes${filtersToSearch(next)}`, { scroll: false }));
  }
  function toggle(key: Facet, value: string) {
    const selected = current[key];
    navigate({
      ...current,
      page: 1,
      [key]: selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value],
    });
  }
  return (
    <section aria-label="Filters" aria-busy={pending} className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex w-full items-center gap-2 sm:w-auto"
          onSubmit={(event) => {
            event.preventDefault();
            navigate({ ...current, q: query.trim(), page: 1 });
          }}
        >
          <div className="relative min-w-0 flex-1 sm:w-72">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
            />
            <Input
              aria-label="Search sandboxes"
              placeholder="Search name or ID…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
        </form>
        {FACETS.map((key) => (
          <Popover key={key}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="border-dashed">
                <ListFilterIcon />
                {LABELS[key]}
                {current[key].length > 0 && <Badge variant="secondary">{current[key].length}</Badge>}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="start">
              <Command>
                <CommandInput placeholder={`Find ${LABELS[key].toLowerCase()}…`} />
                <CommandList>
                  <CommandEmpty>No options found.</CommandEmpty>
                  <CommandGroup heading={key === "owner" ? "Everyone in this organization" : LABELS[key]}>
                    {options[key].map((option) => (
                      <CommandItem
                        key={option.value}
                        value={`${option.label} ${option.value}`}
                        onSelect={() => toggle(key, option.value)}
                        aria-selected={current[key].includes(option.value)}
                      >
                        <span
                          className="flex size-4 shrink-0 items-center justify-center rounded-sm border"
                          aria-hidden
                        >
                          {current[key].includes(option.value) && <CheckIcon className="size-3" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{option.count}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        ))}
        <div className="sm:ml-auto">
          <NativeSelect
            aria-label="Sort sandboxes"
            value={current.sort}
            onChange={(event) => navigate({ ...current, sort: event.target.value as SandboxFilters["sort"], page: 1 })}
          >
            <option value="attention">Needs attention first</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name A–Z</option>
          </NativeSelect>
        </div>
      </div>
      {hasSandboxFilters(current) && (
        <section className="flex flex-wrap items-center gap-2" aria-label="Active filters">
          {current.q && (
            <Button size="sm" variant="secondary" onClick={() => navigate({ ...current, q: "", page: 1 })}>
              Search: {current.q}
              <XIcon />
            </Button>
          )}
          {FACETS.flatMap((key) =>
            current[key].map((value) => (
              <Button
                key={`${key}:${value}`}
                size="sm"
                variant="secondary"
                aria-label={`Remove ${LABELS[key]}: ${options[key].find((item) => item.value === value)?.label ?? value}`}
                onClick={() => toggle(key, value)}
              >
                {LABELS[key]}: {options[key].find((item) => item.value === value)?.label ?? value}
                <XIcon />
              </Button>
            )),
          )}
          <Button variant="ghost" size="sm" onClick={() => navigate(parseSandboxFilters({}))}>
            Clear all
            <XIcon />
          </Button>
        </section>
      )}
      <p className="sr-only" role="status">
        {pending ? "Updating sandboxes" : "Sandboxes updated"}
      </p>
    </section>
  );
}
