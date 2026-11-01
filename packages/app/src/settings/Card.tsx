// One card of Settings › Providers or Connections (THE-2075, after T3 Code's
// ProviderInstanceCard in its list mode, pingdotgg/t3code): the mark, the
// name, the CLI's version in mono, one status line on its dot, and one
// control on the right. The card's text is one button: Enter or a click opens
// its detail below the list (`aria-expanded`), again closes it.
import { type ReactNode, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Mark } from "./marks";
import type { StatusLine } from "./provider-view";

export function Card({
  id,
  mark,
  name,
  version,
  status,
  open,
  dim = false,
  onToggle,
  control,
}: {
  /** The provider's id, or the connection's name: `data-card`, and what the detail's `aria-controls` names. */
  id: string;
  mark: string;
  name: string;
  version?: string | null;
  status: StatusLine;
  open: boolean;
  /** Switched off: quieter until hovered or open. */
  dim?: boolean;
  onToggle: () => void;
  control?: ReactNode;
}) {
  return (
    <div
      data-card={id}
      className={cn(
        "group flex min-h-16 min-w-0 items-center gap-3 px-4 py-3 transition-colors",
        open ? "bg-item-current" : "hover:bg-item-hover",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? detailId(id) : undefined}
        onClick={onToggle}
        className={cn(
          "-m-1 flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-sm p-1 text-left outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-blue",
          dim && !open && "opacity-60 group-hover:opacity-100",
        )}
      >
        <span className="flex size-8 flex-none items-center justify-center rounded-control bg-fill shadow-ring">
          <Mark mark={mark} className="size-4.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span data-card-name className="truncate font-medium text-body text-text">
              {name}
            </span>
            {version && (
              <code data-card-version className="max-w-32 flex-none truncate font-mono text-small text-text-3 tnum">
                {version}
              </code>
            )}
          </span>
          <span data-card-status className={cn("flex min-w-0 items-center gap-1.5 text-small", status.ink)}>
            <span aria-hidden className={cn("size-1.5 flex-none rounded-full", status.dot)} />
            <span className="min-w-0 truncate">
              {status.word}
              {status.detail && <span className="text-text-3"> · {status.detail}</span>}
            </span>
          </span>
        </span>
      </button>
      {control && <div className="flex flex-none items-center gap-2">{control}</div>}
    </div>
  );
}

/** The id of a card's detail, for its `aria-controls`. */
export const detailId = (id: string) => `settings-detail-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;

/**
 * Escape closes the open detail (THE-2075's keyboard), unless a field or a
 * menu holds it, and the focus goes back to the card that opened it.
 */
export function useEscapeCloses(open: string | undefined, close: () => void) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable], [role=dialog], [role=listbox]")) return;
      event.preventDefault();
      close();
      const card = [...document.querySelectorAll<HTMLElement>("[data-card]")].find((c) => c.dataset.card === open);
      card?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);
}

/** Goes to a settings address (a card opened or closed), as a link would. */
export function go(href: string) {
  if (window.location.hash !== href) window.location.hash = href;
}
