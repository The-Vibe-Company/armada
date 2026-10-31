// The room's panel's rules (THE-2085), after T3 Code's right panel
// (`RightPanelTabs.tsx`, `ChatRightPanel.tsx`, `RightPanelSheet.tsx`): its
// width, dragged between two bounds and kept with whether it is open; its tab
// in the address (`?panel=`); the keys that toggle it and pick a tab; the
// window width under which it is a sheet over the conversation; and the agent
// whose page takes the chat's place (`&agent=`, THE-2089), with the keys that
// hop from one agent to the next.
import { useSyncExternalStore } from "react";
import { agentOf, PANEL_TABS, type PanelTab, panelOf, roomHref } from "@/lib/route";

export const PANEL_KEY = "armada.room.panel";
export const PANEL_WIDTH = { initial: 320, min: 240, max: 480 } as const;
/** Below this window width the panel is a sheet over the conversation, closed until asked for. */
const SHEET_BELOW = 900;

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

/** The agent the address shows in the lane, followed as it changes; none (the chat) off a browser. */
export function useRoomAgent(): string | null {
  const hash = useSyncExternalStore(
    onHash,
    () => window.location.hash,
    () => "",
  );
  return agentOf(hash.split("?")[1] ?? "") ?? null;
}

const shownAgent = () => agentOf(window.location.hash.split("?")[1] ?? "");

/** Puts a tab in the address, replacing it: switching tabs adds nothing to Back, and keeps the lane as it is. */
export function showTab(project: string, tab: PanelTab): void {
  const next = roomHref(project, tab, shownAgent());
  if (window.location.hash !== next) window.location.replace(next);
}

/** Where a row of the panel's Agents leads: the agent in the lane, the panel kept on Agents; null is the chat. */
export const agentHref = (project: string, agent: string | null) => roomHref(project, "agents", agent ?? undefined);

/** Shows an agent in the lane (null: the chat) by a key, the panel's tab kept, replacing the address: hopping adds nothing to Back. */
export function showAgent(project: string, agent: string | null): void {
  const tab = panelOf(window.location.hash.split("?")[1] ?? "") ?? "agents";
  const next = roomHref(project, tab, agent ?? undefined);
  if (window.location.hash !== next) window.location.replace(next);
}

/** What a key press asks of the lane: the previous or next agent (`↑` `↓`, `K` `J`), or the chat (Escape). */
export type AgentKey = { kind: "step"; by: -1 | 1 } | { kind: "chat" };

export function agentKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): AgentKey | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "Escape") return { kind: "chat" };
  if (e.shiftKey) return null;
  if (e.key === "ArrowUp" || e.key === "k" || e.key === "K") return { kind: "step", by: -1 };
  if (e.key === "ArrowDown" || e.key === "j" || e.key === "J") return { kind: "step", by: 1 };
  return null;
}

/**
 * The agent a step lands on, in the list's order with the chat (null, the
 * Coordinator row) first; the ends hold, nothing wraps. An agent no longer in
 * the list steps from the chat.
 */
export function agentStep(order: readonly string[], current: string | null, by: -1 | 1): string | null {
  const at = current === null ? -1 : order.indexOf(current);
  const next = Math.min(order.length - 1, Math.max(-1, at + by));
  return next < 0 ? null : (order[next] ?? null);
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
