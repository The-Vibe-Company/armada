"use client";

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CatalogDrawer } from "@/components/catalog-drawer";
import type { ResourceRow } from "@/components/resource-browser";
import { Button } from "@/components/ui/button";

/** Machines share the catalog drawer and tokens, without catalog filters. */
export function MachinesSection({
  label,
  rows,
  initial = null,
  empty,
}: {
  label: string;
  rows: (ResourceRow & { actionLabel?: string })[];
  initial?: string | null;
  empty?: ReactNode;
}) {
  const [selected, setSelected] = useState<string | null>(initial);
  const opener = useRef<HTMLButtonElement | null>(null);
  const root = useRef<HTMLElement>(null);
  const lastSelected = useRef<string | null>(initial);
  const parking = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    setHost(document.createElement("div"));
  }, []);
  const current = rows.find((row) => row.key === selected);
  useLayoutEffect(() => {
    if (host && !current) parking.current?.appendChild(host);
    if (current) lastSelected.current = current.key;
  }, [host, current]);
  useEffect(() => {
    const sync = () => setSelected(new URL(window.location.href).searchParams.get("item"));
    window.addEventListener("popstate", sync);
    sync();
    return () => window.removeEventListener("popstate", sync);
  }, []);
  function select(key: string | null) {
    const url = new URL(window.location.href);
    if (key) url.searchParams.set("item", key);
    else url.searchParams.delete("item");
    if (key) window.history.pushState({ machinesDetail: true }, "", url);
    else if (window.history.state?.machinesDetail) window.history.back();
    else window.history.replaceState(window.history.state, "", url);
    setSelected(key);
  }
  return (
    <section ref={root} aria-label={label} className="space-y-3">
      <h2 className="text-sm font-semibold">{label}</h2>
      {rows.length === 0 ? (
        empty
      ) : (
        <ul aria-label={label} className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <li key={row.key} {...row.attrs} className="relative flex min-w-0 flex-col rounded-[10px] border bg-card">
              <div className="flex items-start gap-3 p-4 pb-3">
                {row.mark}
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    data-select-item={row.key}
                    aria-label={`View ${row.name}`}
                    className="block max-w-full truncate text-left text-sm font-semibold after:absolute after:inset-0 after:rounded-[10px] focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      select(row.key);
                    }}
                  >
                    {row.name}
                  </button>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{row.meta}</div>
                </div>
                <div className="shrink-0 text-xs">{row.state}</div>
              </div>
              {row.fact && <div className="px-4 pb-4 text-xs text-muted-foreground">{row.fact}</div>}
              <div className="mt-auto flex min-h-12 items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
                <span>{row.subtitle}</span>
                <div className="relative z-10">
                  {row.action ?? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                        select(row.key);
                      }}
                    >
                      {row.actionLabel ?? "Details"}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <CatalogDrawer
        open={!!current}
        onOpenChange={(open) => {
          if (!open) select(null);
        }}
        title={current?.name ?? label}
        subtitle={current?.meta}
        mark={current?.mark}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const key = lastSelected.current;
          const fallback = key
            ? root.current?.querySelector<HTMLButtonElement>(`[data-select-item="${CSS.escape(key)}"]`)
            : null;
          (opener.current?.isConnected ? opener.current : fallback)?.focus();
        }}
      >
        <div
          ref={(node) => {
            if (node && host) node.appendChild(host);
          }}
        />
      </CatalogDrawer>
      <div ref={parking} hidden />
      {host &&
        createPortal(
          rows.map((row) => (
            <div key={row.key} hidden={row.key !== selected}>
              {row.detail}
            </div>
          )),
          host,
        )}
    </section>
  );
}
