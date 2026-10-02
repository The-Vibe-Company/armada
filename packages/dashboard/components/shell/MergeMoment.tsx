"use client";

// The merge moment (THE-899): when a ticket ready to merge leaves the fleet,
// its ship leaves the formation (from its row, when the row was on screen)
// and a short confirmation appears at the bottom. Rare and calm; with reduced
// motion the confirmation fades in and nothing flies. It reads the same diff
// as the shell's live region (lib/announce.ts), which says it aloud: the
// confirmation itself is for the eye only.
import type { FleetRow } from "@armada/core/read";
import { useEffect, useRef, useState } from "react";
import { changes, type Watched, watched } from "@/lib/announce";
import { paths } from "@/lib/fleet-view";
import { Ship } from "../mark";
import { useFleet, useShell } from "./context";

/** How long a confirmation stays, then how long it takes to leave (--t-2). */
const SHOWN_MS = 3_600;
const LEAVE_MS = 240;

interface Toast {
  id: number;
  ticket: string;
  pr: number | null;
  leaving: boolean;
}

/** Where a row's status glyph was on screen, and how far its list had scrolled then. */
interface Spot {
  x: number;
  y: number;
  scroll: number;
}

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One Web Animations call: the ship climbs away to the right and fades. */
function fly(spot: Spot, scroller: HTMLElement | null) {
  const y = spot.y - ((scroller?.scrollTop ?? 0) - spot.scroll);
  if (y < 0 || y > window.innerHeight) return;
  const ship = document.createElement("span");
  ship.className = "merge-ship";
  ship.style.left = `${spot.x}px`;
  ship.style.top = `${y}px`;
  ship.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true"><path d="M11.5 6L1 11V1Z"/></svg>';
  document.body.append(ship);
  ship.animate(
    [
      { transform: "translate(0, 0)", opacity: 1 },
      { transform: "translate(140px, -26px)", opacity: 1, offset: 0.7 },
      { transform: "translate(200px, -38px)", opacity: 0 },
    ],
    { duration: 600, easing: "cubic-bezier(0.77, 0, 0.175, 1)", fill: "forwards" },
  ).onfinish = () => ship.remove();
}

export function MergeMoment() {
  const { overview } = useFleet();
  const { t } = useShell();
  const seen = useRef<{ watched: Watched; rows: Map<string, FleetRow> } | null>(null);
  const spots = useRef(new Map<string, Spot>());
  const next = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const now = { watched: watched(overview), rows: new Map(overview.rows.map((r) => [`${r.project}/${r.id}`, r])) };
    const before = seen.current;
    seen.current = now;
    const scroller = document.querySelector<HTMLElement>(".sh-scroll");
    if (before)
      for (const c of changes(before.watched, now.watched)) {
        if (c.kind !== "merged") continue;
        const key = `${c.project}/${c.ticket}`;
        const spot = spots.current.get(key);
        if (spot && !reduced()) fly(spot, scroller);
        const id = ++next.current;
        setToasts((list) => [
          ...list.slice(-2),
          { id, ticket: c.ticket, pr: before.rows.get(key)?.pr?.number ?? null, leaving: false },
        ]);
        setTimeout(() => setToasts((list) => list.map((x) => (x.id === id ? { ...x, leaving: true } : x))), SHOWN_MS);
        setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), SHOWN_MS + LEAVE_MS);
      }
    // Where each ticket ready to merge is drawn now, for the next poll.
    spots.current.clear();
    for (const r of overview.rows) {
      if (r.phase !== "ready-to-merge") continue;
      const glyph = document.querySelector(`a[data-row][href="${paths.agent(r.id)}"] .ui-status`);
      const box = glyph?.getBoundingClientRect();
      if (box?.width)
        spots.current.set(`${r.project}/${r.id}`, { x: box.left, y: box.top, scroll: scroller?.scrollTop ?? 0 });
    }
  }, [overview]);

  if (!toasts.length) return null;
  return (
    <div className="merge-toasts" aria-hidden>
      {toasts.map((x) => (
        <div key={x.id} className={x.leaving ? "merge-toast is-leaving" : "merge-toast"}>
          <Ship color="var(--done)" size={12} />
          <span>
            <b>{t.merge.done(x.ticket)}</b> {x.pr !== null && <span className="faint">{t.merge.onMain(x.pr)}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
