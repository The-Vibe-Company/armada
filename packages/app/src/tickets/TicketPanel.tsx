// The Tickets page's panel (THE-2124), after the room's (room/Panel.tsx): a
// column on the right, 400 px, the list beside it; below 900 px a sheet over
// the list, closed by Escape (not from a field: a draft is never lost to it)
// or a press beside it. It never takes the focus when it opens. Its header names what it shows, then its close button.
import { AnimatePresence, m } from "motion/react";
import { type ReactNode, useEffect } from "react";
import { PANEL_WIDTH } from "@/room/panel-rules";

export const TICKET_PANEL_ID = "ticket-panel";
const SLIDE = { duration: 0.2, ease: [0.23, 1, 0.32, 1] } as const;
/** Wider than the room's default: it holds a form and a description. */
const WIDTH = Math.min(PANEL_WIDTH.max, 400);

export function TicketPanel({
  open,
  sheet,
  heading,
  closeLabel,
  label,
  onClose,
  children,
}: {
  open: boolean;
  sheet: boolean;
  /** What the panel shows: the ticket's id, or "New ticket". */
  heading: ReactNode;
  closeLabel: string;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!sheet || !open) return;
    const close = (e: KeyboardEvent) => {
      const field = e.target instanceof HTMLElement && e.target.closest("input, textarea, select");
      if (e.key === "Escape" && !e.defaultPrevented && !field) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [sheet, open, onClose]);

  const body = (
    <>
      <div className="flex h-11 flex-none items-center gap-2 border-line border-b px-4">
        <span className="min-w-0 truncate font-mono text-meta text-text-2" data-panel-heading>
          {heading}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="ml-auto inline-flex size-7 flex-none cursor-pointer items-center justify-center rounded-sm text-[18px] text-text-3 leading-none hover:bg-panel-3 hover:text-text"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{children}</div>
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
              id={TICKET_PANEL_ID}
              aria-label={label}
              data-sheet
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={SLIDE}
              className="absolute inset-y-0 right-0 z-30 flex w-[min(92vw,26rem)] min-w-0 flex-col bg-card shadow-[-1px_0_0_var(--color-line)]"
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
      id={TICKET_PANEL_ID}
      aria-label={label}
      style={{ width: WIDTH }}
      className="relative flex min-w-0 flex-none flex-col bg-card shadow-[-1px_0_0_var(--color-line)]"
    >
      {body}
    </aside>
  );
}
