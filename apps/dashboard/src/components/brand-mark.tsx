import { ShipIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** The mark: the landing's lime behind the ship, so the app and the public pages read as one product. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground shadow-xs ring-1 ring-black/5 ring-inset [&_svg]:size-4",
        className,
      )}
    >
      <ShipIcon strokeWidth={2.25} />
    </span>
  );
}
