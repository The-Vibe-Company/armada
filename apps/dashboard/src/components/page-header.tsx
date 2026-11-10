import type { ReactNode } from "react";

/** The title of a page, one line saying what it holds, and its primary action on the right. */
export function PageHeader({
  title,
  description,
  meta,
  children,
}: {
  title: string;
  description?: string;
  /** A quiet fact beside the title, such as how many items the page holds. */
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl space-y-1.5">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {meta !== undefined && <span className="text-sm text-muted-foreground tabular-nums">{meta}</span>}
        </div>
        {description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
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
    <div className="rounded-xl border border-dashed bg-card/50 px-6 py-10 text-center">
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
