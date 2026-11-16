import { cn } from "@/lib/utils";

/** The fleet mark from the owner's November 2026 prototype. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-[30px] shrink-0 items-center justify-center rounded-lg border border-border bg-[oklch(0.17_0.006_265)]",
        className,
      )}
    >
      <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 4.5L20 11.5H12Z" fill="#b6f15a" />
        <path d="M10 13L14 20H6Z M22 13L26 20H18Z" fill="#f0efec" />
        <path d="M4 21.5L8 28.5H0Z M28 21.5L32 28.5H24Z" fill="#f0efec" fillOpacity="0.45" />
      </svg>
    </span>
  );
}
