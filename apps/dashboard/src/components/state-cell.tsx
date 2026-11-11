import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, CircleXIcon, LoaderCircleIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

const ICONS: Record<Tone, typeof CircleCheckIcon> = {
  success: CircleCheckIcon,
  warning: CircleAlertIcon,
  destructive: CircleXIcon,
  neutral: CircleDashedIcon,
  info: LoaderCircleIcon,
};

const TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  neutral: "text-muted-foreground",
  info: "text-info",
};

/**
 * An item's state in a Build list (#808): an icon and plain words in the tone of the state. The sentence that
 * completes it is read aloud; on screen, the item's panel says it in full (a row's whole surface opens the panel,
 * so a hover title there would never show). The words carry the meaning; icon and colour only repeat it.
 */
export function StateCell({
  tone,
  label,
  detail,
  className,
  ...props
}: { tone: Tone; label: string; detail?: string | undefined } & ComponentProps<"span">) {
  const Icon = ICONS[tone];
  return (
    <span
      title={detail}
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-sm font-medium", TEXT[tone], className)}
      {...props}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
      {detail && <span className="sr-only">. {detail}</span>}
    </span>
  );
}

/** A small tag beside a row's name: who it belongs to (Private, Org, Personal). */
export function RowTag({ className, ...props }: ComponentProps<"span">) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-[11px] leading-4 font-medium text-muted-foreground [&_svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}

/** A labelled group of facts in a detail panel. */
export function PanelSection({ title, children, className, ...props }: { title: string } & ComponentProps<"section">) {
  return (
    <section className={cn("space-y-2 border-t pt-4 first:border-t-0 first:pt-0", className)} {...props}>
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}
