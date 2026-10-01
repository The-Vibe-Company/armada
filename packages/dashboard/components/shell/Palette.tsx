"use client";

// ⌘K: go to an agent, a project, a ticket ready to start or a section. Reads
// the polled overview only; ↑/↓ choose, Enter opens, Esc closes. The focus
// stays in its field while it is open, and goes back where it was when it
// closes (THE-891).
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { filterSearch, type SearchItem, searchItems } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import { ProjectChip, StatusDot } from "../ui";
import { useFleet, useShell } from "./context";
import { SearchIcon } from "./Logo";
import { stateLabel } from "./labels";

function describe(t: Strings, item: SearchItem, phaseOf: (key: string) => Parameters<typeof stateLabel>[2] | null) {
  if (item.kind === "nav") {
    const to = item.hay as keyof Strings["shell"]["nav"];
    return { label: t.shell.palette.goTo(t.shell.nav[to]), detail: t.shell.palette.navigation };
  }
  if (item.kind === "project") return { label: item.label, detail: t.shell.palette.project(item.detail) };
  if (item.kind === "ticket") return { label: item.label, detail: t.shell.palette.ticket(item.detail) };
  const phase = phaseOf(item.key);
  return {
    label: item.label,
    detail: item.state && phase ? `${item.detail} · ${stateLabel(t, item.state, phase)}` : item.detail,
  };
}

export function Palette({ onClose }: { onClose: () => void }) {
  const { t } = useShell();
  const { overview } = useFleet();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const all = useMemo(() => searchItems(overview), [overview]);
  const phases = useMemo(() => new Map(overview.rows.map((r) => [`agent:${r.project}:${r.id}`, r.phase])), [overview]);
  const navWords = t.shell.nav;
  const items = useMemo(() => filterSearch(all, query, { navWords }), [all, query, navWords]);
  const at = Math.min(index, Math.max(0, items.length - 1));

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const go = (item: SearchItem | undefined) => {
    if (!item) return;
    onClose();
    router.push(item.href);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop closes on click; Esc closes it from the keyboard.
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above.
    <div className="sh-palette-backdrop" onClick={onClose}>
      <div
        className="sh-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t.shell.palette.label}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "Tab") {
            // Its field is its only stop: the focus stays in the dialog.
            e.preventDefault();
            input.current?.focus();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex(Math.min(items.length - 1, at + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex(Math.max(0, at - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            go(items[at]);
          }
        }}
      >
        <div className="sh-palette-input">
          <SearchIcon size={15} />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            placeholder={t.shell.palette.placeholder}
            aria-label={t.shell.palette.label}
            aria-controls="sh-palette-list"
            aria-activedescendant={items[at] ? `sh-pal-${at}` : undefined}
            role="combobox"
            aria-expanded="true"
          />
          <kbd className="ui-kbd">esc</kbd>
        </div>
        <div className="sh-palette-list" id="sh-palette-list" role="listbox">
          {items.map((item, i) => {
            const d = describe(t, item, (key) => phases.get(key) ?? null);
            return (
              <div
                key={item.key}
                id={`sh-pal-${i}`}
                role="option"
                aria-selected={i === at}
                tabIndex={-1}
                className="sh-palette-item"
                onMouseMove={() => i !== at && setIndex(i)}
                onClick={() => go(item)}
                onKeyDown={undefined}
              >
                {item.kind === "agent" && item.state ? (
                  <StatusDot status={item.state.status} />
                ) : item.kind === "project" && item.project ? (
                  <ProjectChip slug={item.project} bare />
                ) : (
                  <span className="sh-palette-mark" aria-hidden />
                )}
                <span className="sh-palette-label">{d.label}</span>
                <span className="sh-palette-detail">{d.detail}</span>
              </div>
            );
          })}
          {items.length === 0 && <div className="sh-palette-empty">{t.shell.palette.empty}</div>}
        </div>
      </div>
    </div>
  );
}
