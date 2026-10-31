// The room's panel (THE-2085), after T3 Code's right panel (`RightPanelTabs.tsx`,
// `ChatRightPanel.tsx`, `RightPanelSheet.tsx`): its tabs on top (Agents, Pull
// requests, Rules, Log), the tab's content under them, 320 px wide by default
// and dragged by its left edge between 240 and 480. Below 900 px it is a sheet
// over the conversation, closed by Escape or a press beside it; it never takes
// the focus when it opens.
import { AnimatePresence, m } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { PANEL_TABS, type PanelTab } from "@/lib/route";
import { cn } from "@/lib/utils";
import { clampWidth, PANEL_LABEL, PANEL_WIDTH } from "./panel-rules";

export const PANEL_ID = "room-panel";
const SLIDE = { duration: 0.2, ease: [0.23, 1, 0.32, 1] } as const;
/** An arrow key on the edge moves it this far. */
const STEP = 16;

export function Panel({
  open,
  sheet,
  tab,
  counts,
  width,
  onTab,
  onWidth,
  onClose,
  children,
}: {
  open: boolean;
  /** A sheet over the conversation (a narrow window), not a column beside it. */
  sheet: boolean;
  tab: PanelTab;
  /** A number beside a tab's name: "Pull requests 3" (THE-2086). */
  counts?: Partial<Record<PanelTab, number>>;
  width: number;
  onTab: (tab: PanelTab) => void;
  /** The width the owner dragged to, once the drag ends: the panel follows the drag on its own. */
  onWidth: (width: number) => void;
  onClose: () => void;
  /** The open tab's content. */
  children: ReactNode;
}) {
  // While dragged, only the panel follows the pointer; the room hears the width the drag ends on.
  const [dragged, setDragged] = useState<number | null>(null);
  // Escape closes the sheet, wherever the focus is.
  useEffect(() => {
    if (!sheet || !open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [sheet, open, onClose]);

  const body = (
    <>
      <div className="flex h-11 flex-none items-center gap-0.5 border-line border-b px-2">
        <div role="tablist" aria-label="Panel" className="flex min-w-0 items-center gap-0.5">
          {PANEL_TABS.map((t, k) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`${PANEL_ID}-tab-${t}`}
              aria-selected={t === tab}
              aria-controls={`${PANEL_ID}-content`}
              tabIndex={t === tab ? 0 : -1}
              title={`${PANEL_LABEL[t]} (⌘${k + 1})`}
              onClick={() => onTab(t)}
              onKeyDown={(e) => {
                const move = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                if (!move) return;
                e.preventDefault();
                const next = PANEL_TABS[(k + move + PANEL_TABS.length) % PANEL_TABS.length] ?? t;
                onTab(next);
                document.getElementById(`${PANEL_ID}-tab-${next}`)?.focus();
              }}
              className="h-7 cursor-pointer whitespace-nowrap rounded-sm px-2 text-body text-text-3 transition-colors hover:text-text aria-selected:bg-fill aria-selected:text-text"
            >
              {PANEL_LABEL[t]}
              {counts?.[t] ? (
                // The space keeps the name and its number two words for a screen reader: "Pull requests 3".
                <span className="ml-1 font-mono text-meta text-text-3 tnum" data-tab-count>
                  {" "}
                  {counts[t]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the panel"
          className="ml-auto inline-flex size-7 flex-none cursor-pointer items-center justify-center rounded-sm text-[18px] text-text-3 leading-none hover:bg-panel-3 hover:text-text"
        >
          ×
        </button>
      </div>
      <div
        role="tabpanel"
        id={`${PANEL_ID}-content`}
        aria-labelledby={`${PANEL_ID}-tab-${tab}`}
        data-panel-tab={tab}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        {children}
      </div>
    </>
  );

  if (sheet)
    return (
      <AnimatePresence initial={false}>
        {open && (
          <>
            <m.div
              key="scrim"
              aria-hidden
              // A press beside the sheet keeps the focus where it was, so closing can hand it back.
              onMouseDown={(e) => e.preventDefault()}
              onClick={onClose}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={SLIDE}
              className="absolute inset-0 z-20 bg-black/40"
            />
            <m.aside
              key="sheet"
              id={PANEL_ID}
              aria-label="Panel"
              data-sheet
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={SLIDE}
              className="absolute inset-y-0 right-0 z-30 flex w-[min(88vw,24rem)] min-w-0 flex-col bg-card shadow-[-1px_0_0_var(--color-line)]"
            >
              {body}
            </m.aside>
          </>
        )}
      </AnimatePresence>
    );
  if (!open) return null;
  return (
    <aside
      id={PANEL_ID}
      aria-label="Panel"
      style={{ width: dragged ?? width }}
      className="relative flex min-w-0 flex-none flex-col bg-card shadow-[-1px_0_0_var(--color-line)]"
    >
      <Edge
        width={dragged ?? width}
        onWidth={(next, done) => {
          setDragged(done ? null : next);
          if (done) onWidth(next);
        }}
      />
      {body}
    </aside>
  );
}

/** The panel's left edge: dragged, or moved by the arrow keys, it sets the width. */
function Edge({ width, onWidth }: { width: number; onWidth: (width: number, done: boolean) => void }) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a separator that can be moved needs the focus, which `<hr>` cannot take.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuenow={width}
      aria-valuemin={PANEL_WIDTH.min}
      aria-valuemax={PANEL_WIDTH.max}
      tabIndex={0}
      data-panel-edge
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width, last: width };
      }}
      onPointerMove={(e) => {
        const held = drag.current;
        if (!held) return;
        held.last = clampWidth(held.width + held.x - e.clientX);
        onWidth(held.last, false);
      }}
      onPointerUp={(e) => {
        const held = drag.current;
        if (!held) return;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        onWidth(held.last, true);
      }}
      onPointerCancel={() => {
        const held = drag.current;
        drag.current = null;
        if (held) onWidth(held.last, true);
      }}
      onKeyDown={(e) => {
        const move = e.key === "ArrowLeft" ? STEP : e.key === "ArrowRight" ? -STEP : 0;
        if (!move) return;
        e.preventDefault();
        onWidth(clampWidth(width + move), true);
      }}
      className={cn(
        "absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none",
        "after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:transition-colors hover:after:bg-line-strong focus-visible:after:bg-blue",
      )}
    />
  );
}
