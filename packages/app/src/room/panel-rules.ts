// The room's panel's rules (THE-2085), after T3 Code's right panel
// (`RightPanelTabs.tsx`, `ChatRightPanel.tsx`, `RightPanelSheet.tsx`): its
// width, dragged between two bounds and kept with whether it is open; its tab
// in the address (`?panel=`); the keys that toggle it and pick a tab; and the
// window width under which it is a sheet over the conversation.
import { useSyncExternalStore } from "react";
import { PANEL_TABS, type PanelTab, panelOf, roomHref } from "@/lib/route";

export const PANEL_KEY = "armada.room.panel";
export const PANEL_WIDTH = { initial: 320, min: 240, max: 480 } as const;
/** Below this window width the panel is a sheet over the conversation, closed until asked for. */
export const SHEET_BELOW = 900;

export const PANEL_LABEL: Record<PanelTab, string> = {
  agents: "Agents",
  prs: "Pull requests",
  rules: "Rules",
  log: "Log",
};

export interface PanelStore {
  width: number;
  /** Null until the owner opened or closed it: open by default. */
  open: boolean | null;
}

export interface PanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const clampWidth = (width: number) =>
  Math.round(Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, Number.isFinite(width) ? width : 0)));

/** The panel as the owner left it; the defaults for anything unreadable. */
export function readPanel(storage: PanelStorage | null): PanelStore {
  try {
    const held: unknown = JSON.parse(storage?.getItem(PANEL_KEY) ?? "null");
    const o = held !== null && typeof held === "object" ? (held as Record<string, unknown>) : {};
    return {
      width: typeof o.width === "number" ? clampWidth(o.width) : PANEL_WIDTH.initial,
      open: typeof o.open === "boolean" ? o.open : null,
    };
  } catch {
    return { width: PANEL_WIDTH.initial, open: null };
  }
}

export function writePanel(storage: PanelStorage | null, panel: PanelStore): void {
  try {
    storage?.setItem(PANEL_KEY, JSON.stringify({ width: clampWidth(panel.width), open: panel.open }));
  } catch {
    // A full or refused storage only forgets the panel's size.
  }
}

export const browserPanel = (): PanelStorage | null => (typeof localStorage === "undefined" ? null : localStorage);

export type PanelKey = { kind: "toggle" } | { kind: "tab"; tab: PanelTab };

/** What a key press asks of the panel: `⌘.` toggles it, `⌘1` to `⌘4` pick a tab (Ctrl off a Mac). */
export function panelKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): PanelKey | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return null;
  if (e.key === ".") return { kind: "toggle" };
  const tab = PANEL_TABS[Number(e.key) - 1];
  return /^[1-4]$/.test(e.key) && tab ? { kind: "tab", tab } : null;
}

const onHash = (change: () => void) => {
  window.addEventListener("hashchange", change);
  return () => window.removeEventListener("hashchange", change);
};

/** The tab the address names, followed as it changes; none off a browser. */
export function usePanelTab(): PanelTab | null {
  const hash = useSyncExternalStore(
    onHash,
    () => window.location.hash,
    () => "",
  );
  return panelOf(hash.split("?")[1] ?? "") ?? null;
}

/** Puts a tab in the address, replacing it: switching tabs adds nothing to Back. */
export function showTab(project: string, tab: PanelTab): void {
  const next = roomHref(project, tab);
  if (window.location.hash !== next) window.location.replace(next);
}

const NARROW = `(max-width: ${SHEET_BELOW - 0.02}px)`;
const onWidth = (change: () => void) => {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

/** Whether the window is narrow enough for the sheet; wide off a browser. */
export function useSheet(): boolean {
  return useSyncExternalStore(
    onWidth,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}
