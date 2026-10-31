// The room's panel's state (THE-2085): its tab in the address, its width and
// whether it is open kept on this machine, a sheet on a narrow window (closed
// until asked for); the keys that toggle it and pick its tab; and where it goes
// when a pill or the field's Answer opens it. An address naming a tab opens it.
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { groupHeadingId } from "@/components/fleet/FleetList";
import type { Group } from "@/fleet/overview";
import type { PanelTab } from "@/lib/route";
import {
  browserPanel,
  type PanelStore,
  panelKey,
  readPanel,
  showTab,
  usePanelTab,
  useSheet,
  writePanel,
} from "./panel-rules";

/** Where the panel goes once it shows Agents: a group's heading, or the question's card. */
interface Target {
  to: Group | "question";
  /** Gives it the focus too; a pill on the sheet leaves the focus where it was. */
  focus: boolean;
}

export interface RoomPanel {
  sheet: boolean;
  tab: PanelTab;
  open: boolean;
  width: number;
  setOpen: (open: boolean) => void;
  setTab: (tab: PanelTab) => void;
  /** Keeps a width the owner dragged to. */
  setWidth: (width: number) => void;
  /** Opens the panel on a tab. */
  show: (tab: PanelTab) => void;
  /** Opens Agents and goes there. */
  goTo: (to: Target["to"], focus: boolean) => void;
  /** Around the panel: what the focus and the scrolling look in. */
  root: RefObject<HTMLDivElement | null>;
  /** The header's toggle: the focus comes back to it when the panel leaves with it. */
  toggle: RefObject<HTMLButtonElement | null>;
}

export function useRoomPanel(project: string): RoomPanel {
  const sheet = useSheet();
  const routed = usePanelTab();
  const tab: PanelTab = routed ?? "agents";
  const [store, setStore] = useState<PanelStore>(() => {
    const held = readPanel(browserPanel());
    return routed ? { ...held, open: true } : held;
  });
  const [sheetOpen, setSheetOpen] = useState(false);
  const open = sheet ? sheetOpen : (store.open ?? true);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      // The panel leaving with the focus in it hands the focus back to its toggle.
      if (!next && root.current?.contains(document.activeElement)) toggle.current?.focus();
      if (sheet) return setSheetOpen(next);
      const kept = { ...store, open: next };
      writePanel(browserPanel(), kept);
      setStore(kept);
    },
    [sheet, store],
  );
  const setWidth = useCallback(
    (width: number) => {
      const kept = { ...store, width };
      writePanel(browserPanel(), kept);
      setStore(kept);
    },
    [store],
  );
  const setTab = useCallback((next: PanelTab) => showTab(project, next), [project]);
  const show = useCallback(
    (next: PanelTab) => {
      showTab(project, next);
      setOpen(true);
    },
    [project, setOpen],
  );

  // A tab named by a later address (Back, a link, the old rules page) opens the panel beside the conversation too.
  const named = useRef(routed);
  useEffect(() => {
    if (routed === named.current) return;
    named.current = routed;
    if (routed && !sheet && !open) setOpen(true);
  }, [routed, sheet, open, setOpen]);

  const [target, setTarget] = useState<Target | null>(null);
  const goTo = useCallback(
    (to: Target["to"], focus: boolean) => {
      showTab(project, "agents");
      setOpen(true);
      setTarget({ to, focus });
    },
    [project, setOpen],
  );
  // Once Agents shows, the panel goes to the group's heading (or the question's card), within itself only.
  useEffect(() => {
    if (!target || !open || tab !== "agents") return;
    const panel = root.current;
    const el =
      target.to === "question"
        ? panel?.querySelector<HTMLElement>("[data-pinned] button, [data-pinned] input")
        : panel?.querySelector<HTMLElement>(`#${groupHeadingId(target.to)}`);
    const scroller = panel?.querySelector<HTMLElement>('[role="tabpanel"]');
    if (!el || !scroller) return;
    // The heading at the top of the scrolled tab, wherever the tab's own top sits in the panel.
    scroller.scrollTop =
      target.to === "question"
        ? 0
        : scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (target.focus) el.focus({ preventScroll: true });
    setTarget(null);
  }, [target, open, tab]);

  // ⌘. toggles the panel, ⌘1 to ⌘4 pick its tab while it is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = panelKey(e);
      if (!key || (key.kind === "tab" && !open)) return;
      e.preventDefault();
      if (key.kind === "toggle") setOpen(!open);
      else showTab(project, key.tab);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen, project]);

  return { sheet, tab, open, width: store.width, setOpen, setTab, setWidth, show, goTo, root, toggle };
}
