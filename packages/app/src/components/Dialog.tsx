import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A modal over the window (THE-2081): a `role="dialog"` named by its title,
 * the focus on its first field (or the element marked `data-autofocus`) and
 * kept inside it, Escape or a click outside closes it, and the focus goes
 * back to what opened it.
 */
export function Dialog({
  title,
  onClose,
  children,
  className,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const leave = useRef(onClose);
  leave.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inside = () => [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    (box.current?.querySelector<HTMLElement>("[data-autofocus]") ?? inside()[0] ?? box.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        // Handled here: the room's lane, listening on the window, does not also leave the agent.
        e.preventDefault();
        leave.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = inside();
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const out = !(active instanceof Node && box.current?.contains(active));
      if (!first || !last) e.preventDefault();
      else if (e.shiftKey && (active === first || out)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || out)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: a click on the backdrop closes, as Escape does from the keyboard.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#000]/55 px-4 pt-[12vh] pb-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "flex w-full max-w-[520px] flex-col gap-4 rounded-card bg-card p-5 shadow-pop outline-none",
          className,
        )}
      >
        <h2 id={titleId} className="m-0 font-semibold text-bar text-text">
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
