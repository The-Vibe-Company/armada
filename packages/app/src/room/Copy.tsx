// A Copy button (THE-2050, after T3 Code's): its icon turns into a check and
// its label says "Copied" for a moment once the clipboard holds the text.
import { Check, Copy as CopyIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const SHOWN = 1200;

/** Writes to the clipboard and says so for a moment: `copied` holds what was copied (a format, or true). */
export function useCopy<T extends string | true = true>() {
  const [copied, setCopied] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((text: string, what: T = true as T) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        clearTimeout(timer.current);
        setCopied(what);
        timer.current = setTimeout(() => setCopied(null), SHOWN);
      },
      () => {
        /* The clipboard was refused: nothing changes, nothing is said. */
      },
    );
  }, []);
  return { copied, copy };
}

/** The Copy glyph that becomes a check, crossfading in place. */
export function CopyGlyph({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden
      className="relative inline-grid size-3.5 place-items-center [&>svg]:col-start-1 [&>svg]:row-start-1"
    >
      <CopyIcon
        strokeWidth={1.75}
        className={cn("size-3.5 transition-[opacity,scale] ease-out", done ? "scale-50 opacity-0" : "opacity-100")}
      />
      <Check
        strokeWidth={1.75}
        className={cn("size-3.5 transition-[opacity,scale] ease-out", done ? "opacity-100" : "scale-50 opacity-0")}
      />
    </span>
  );
}

/** A small quiet button holding an icon, its label for screen readers and the tooltip. */
export function IconButton({
  label,
  pressed,
  onClick,
  children,
  className,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex size-6 flex-none cursor-pointer items-center justify-center rounded-sm text-text-3 transition-colors hover:bg-fill-2 hover:text-text aria-pressed:bg-fill-2 aria-pressed:text-text-2",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Copy, as an icon: "Copy" until the clipboard holds `text`, then "Copied". */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const { copied, copy } = useCopy();
  return (
    <IconButton label={copied ? "Copied" : label} onClick={() => copy(text)} className={className}>
      <CopyGlyph done={!!copied} />
    </IconButton>
  );
}
