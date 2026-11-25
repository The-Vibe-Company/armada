import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The title of a page, one line saying what it holds, and its primary action on the right. */
export function PageHeader({
  inlineActions = false,
  title,
  description,
  meta,
  children,
}: {
  inlineActions?: boolean;
  title: string;
  description?: ReactNode;
  /** A quiet fact beside the title, such as how many items the page holds. */
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header
      className={cn("flex flex-wrap justify-between gap-x-4 gap-y-2", inlineActions ? "items-center" : "items-start")}
    >
      <div className="min-w-0 max-w-2xl flex-[1_1_9rem] space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <h1 className="min-w-0 text-xl! font-semibold tracking-[-0.02em]! wrap-anywhere">{title}</h1>
          {meta !== undefined && <span className="text-sm text-muted-foreground tabular-nums">{meta}</span>}
        </div>
        {description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

/** A section heading inside a page: what the group is and who sees it. */
export function SectionHeader({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div className="space-y-0.5">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** An empty list: what is missing, and the action that fills it. An icon, when given, says what kind of thing is missing. */
export function Empty({
  title,
  children,
  action,
  icon,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card px-6 py-10 text-center">
      {icon && (
        <div
          aria-hidden="true"
          className="mx-auto mb-3 flex size-10 items-center justify-center rounded-lg border bg-background text-muted-foreground shadow-xs [&_svg]:size-5"
        >
          {icon}
        </div>
      )}
      <p className="font-medium">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-pretty text-muted-foreground">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
