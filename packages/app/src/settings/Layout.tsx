// The settings' anatomy, after T3 Code's (pingdotgg/t3code,
// apps/web/src/components/settings: settingsLayout.tsx, SettingsGroup.tsx,
// SettingsSidebarNav.tsx, FoldedSettingsSection.tsx) without its scopes,
// search and environments (Armada has one daemon): a nav of sections, then
// the section's groups, each a card of rows divided by a hairline, each row a
// title, a description and one control on the right. The nav itself is Nav.tsx (THE-2075).
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cn } from "@/lib/utils";

/** A section's group under its heading. */
export function SettingsSection({
  title,
  count,
  end,
  children,
}: {
  title: ReactNode;
  count?: number;
  end?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-h-7 items-center justify-between gap-4 px-1">
        <h2 id={id} className="m-0 flex items-center gap-2 font-semibold text-sub">
          <span>{title}</span>
          {count !== undefined && <span className="font-mono font-normal text-heading text-text-3 tnum">{count}</span>}
        </h2>
        {end}
      </div>
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  );
}

/** The grouped card: its rows divided by a hairline. */
export function SettingsGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-settings-group
      className={cn("min-w-0 rounded-card bg-card shadow-ring [&>*+*]:border-line-soft [&>*+*]:border-t", className)}
    >
      {children}
    </div>
  );
}

/**
 * One setting: its title, a description and a status under it, its one
 * control on the right (under the text when the row is narrow), and what
 * folds below it (`children`).
 */
export function SettingsRow({
  title,
  description,
  status,
  control,
  children,
  ...rest
}: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
} & { [data: `data-${string}`]: string | undefined }) {
  return (
    <div {...rest} data-settings-row className={cn("@container/row min-w-0 px-4", children ? "pt-3 pb-1" : "py-3")}>
      <div className="flex flex-col gap-3 @min-[32rem]/row:grid @min-[32rem]/row:grid-cols-[minmax(0,1fr)_auto] @min-[32rem]/row:items-center @min-[32rem]/row:gap-8">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="m-0 flex min-h-5 min-w-0 items-baseline gap-2 font-medium text-body">{title}</h3>
          {description && <div className="max-w-2xl text-pretty text-small text-text-2">{description}</div>}
          {status && <div className="pt-0.5 text-small">{status}</div>}
        </div>
        {control && <div className="flex min-w-0 items-center gap-2 @min-[32rem]/row:justify-end">{control}</div>}
      </div>
      {children}
    </div>
  );
}

/** A row's settings, folded below it until opened. */
export function SettingsFold({
  label,
  name,
  children,
}: {
  label: ReactNode;
  /** The button's accessible name when the label alone repeats from row to row. */
  name?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        aria-label={name}
        onClick={() => setOpen(!open)}
        className="-mx-1 flex h-7 w-fit cursor-pointer items-center gap-1 rounded-sm px-1 text-small text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-blue"
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")}
        />
        {label}
      </button>
      {/* Kept in the page while folded: a form's typing survives closing it. */}
      <div id={panel} hidden={!open} className="-mx-4 mt-1 border-line-soft border-t px-4 pt-3.5 pb-3">
        {children}
      </div>
    </div>
  );
}

/** A state word on its dot (the direction: the state on a dot, never a coloured border). */
export function StateDot({ word, dot, ink, title }: { word: string; dot: string; ink: string; title?: string }) {
  return (
    <span data-state title={title} className={cn("inline-flex items-center gap-1.5", ink)}>
      <span aria-hidden className={cn("size-1.5 flex-none rounded-full", dot)} />
      <span>{word}</span>
    </span>
  );
}

/**
 * A section folded under its heading until opened (T3 Code's
 * FoldedSettingsSection): About's Advanced. What it holds stays in the page
 * while folded, as `SettingsFold`'s does.
 */
export function FoldedSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <h2 className="m-0 px-1 font-semibold text-sub">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
          className="-mx-1 flex h-7 cursor-pointer items-center gap-1.5 rounded-sm px-1 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-blue"
        >
          <ChevronRight
            aria-hidden
            className={cn("size-4 transition-transform motion-reduce:transition-none", open && "rotate-90")}
          />
          {title}
        </button>
      </h2>
      <div id={panel} hidden={!open} data-folded={title} className="flex min-w-0 flex-col gap-7">
        {children}
      </div>
    </section>
  );
}
