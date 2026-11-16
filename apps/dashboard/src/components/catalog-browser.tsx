"use client";

import type { ComponentProps } from "react";
import { useState } from "react";
import { ResourceBrowser, type ResourceRow } from "@/components/resource-browser";
import { Input } from "@/components/ui/input";
import styles from "./catalog-browser.module.css";

function CatalogCard({ row }: { row: ResourceRow }) {
  return (
    <article className="flex min-w-0 flex-1 flex-col self-stretch">
      <div className="flex min-w-0 items-start gap-3 p-4 pb-0">
        {row.mark}
        <div className="min-w-0 flex-1 space-y-1">
          <span className="block truncate text-sm font-semibold">{row.name}</span>
          <div className="truncate text-xs text-muted-foreground">{row.meta}</div>
        </div>
        <div className="shrink-0 text-xs">{row.state}</div>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4 text-[13px] text-muted-foreground">
        {row.fact && <div className="line-clamp-2 leading-relaxed">{row.fact}</div>}
        {row.tags && <div className="flex flex-wrap gap-1.5">{row.tags}</div>}
      </div>
      <div className="flex min-h-[46px] items-center gap-3 border-t px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{row.subtitle ?? row.meta}</span>
        <div className="relative z-10 shrink-0">{row.action}</div>
      </div>
    </article>
  );
}

/** Catalog-specific presentation with the existing resource history/focus controller. */
export function CatalogBrowser({
  layout = "cards",
  filters = [],
  ...props
}: ComponentProps<typeof ResourceBrowser> & {
  layout?: "cards" | "table";
  filters?: { label: string; match: string }[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const matches = (row: ResourceRow, term: string) => row.search.toLowerCase().includes(term.toLowerCase());
  const visible = (row: ResourceRow) =>
    matches(row, query.trim()) && (!filter || row.attrs?.["data-catalog-filter"]?.split(" ").includes(filter));
  const shown = props.rows.filter(visible);
  return (
    <div className={layout === "table" ? `${styles.catalog} ${styles.table}` : styles.catalog}>
      <ResourceBrowser
        {...props}
        notices={
          <>
            {props.notices}
            {props.rows.length > 0 && shown.length === 0 && (
              <p role="status" className="rounded-lg border border-dashed p-8 text-center text-sm">
                Nothing matches.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    setQuery("");
                    setFilter("");
                  }}
                >
                  Clear filters
                </button>
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <fieldset aria-label="Filter catalog" className="flex flex-wrap gap-0.5 rounded-lg bg-muted p-[3px]">
                {[{ label: "All", match: "" }, ...filters].map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={filter === option.match}
                    onClick={() => setFilter(option.match)}
                    className={`h-7 rounded-md px-2.5 text-[13px] font-medium ${filter === option.match ? "bg-card shadow-xs" : "text-muted-foreground"}`}
                  >
                    {option.label}{" "}
                    <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                      {
                        props.rows.filter(
                          (row) =>
                            !option.match || row.attrs?.["data-catalog-filter"]?.split(" ").includes(option.match),
                        ).length
                      }
                    </span>
                  </button>
                ))}
              </fieldset>
              <Input
                aria-label={`Search ${props.label.toLowerCase()}`}
                placeholder={`Search ${props.label.toLowerCase()}…`}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-[34px] w-[260px] max-w-full"
              />
            </div>
          </>
        }
        rows={props.rows.map((row) =>
          layout === "cards"
            ? {
                ...row,
                mark: <CatalogCard row={row} />,
                attrs: { ...row.attrs, "data-catalog-shown": String(visible(row)) },
                meta: null,
                tags: null,
                state: null,
                fact: null,
                action: undefined,
              }
            : { ...row, attrs: { ...row.attrs, "data-catalog-shown": String(visible(row)) } },
        )}
        empty={
          query || filter ? (
            <div className="rounded-[10px] border border-dashed px-4 py-12 text-center text-sm">
              <p>Nothing matches</p>
              <button
                type="button"
                className="mt-3 rounded-md border px-3 py-1.5"
                onClick={() => {
                  setQuery("");
                  setFilter("");
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            props.empty
          )
        }
      />
    </div>
  );
}
