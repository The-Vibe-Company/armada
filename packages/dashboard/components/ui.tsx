"use client";

// The shared components of the dashboard (THE-866, THE-1021): the small parts
// rows are made of (status dots, project marks, tabs, times, an empty state).
// The page kit is components/page.tsx; styles are the `ui-*` classes of
// globals.css.
import Link from "next/link";
import type { ReactNode } from "react";
import { type AgentStatus, projectColor } from "@/lib/fleet-view";
import { tabStep } from "@/lib/keyboard";
import { useNow, useShell } from "./shell/context";

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/**
 * An agent's status as the mockup draws it: a ring with a dot (waiting), a
 * filled ring (error, done), a dashed ring (silent) or a ring filling with
 * progress (running, `progress` from 0 to 100).
 */
export function StatusDot({
  status,
  progress = 50,
  size = 13,
  label,
}: {
  status: AgentStatus;
  progress?: number;
  size?: number;
  /** Read by screen readers; the dot is decorative without it. */
  label?: string;
}) {
  const style = { width: size, height: size, ["--p" as string]: `${progress}%` };
  return label ? (
    <span role="img" aria-label={label} className={`ui-status is-${status}`} style={style} />
  ) : (
    <span aria-hidden className={`ui-status is-${status}`} style={style} />
  );
}

/** A small round mark in a color; `pulse` for something live. */
export function Dot({
  color,
  size = 7,
  pulse,
}: {
  color: string;
  size?: number;
  pulse?: "pulse" | "live" | "breathe";
}) {
  return (
    <span
      className={cx("ui-dot", pulse && `is-${pulse}`)}
      style={{ width: size, height: size, background: color }}
      aria-hidden
    />
  );
}

/** A project's color square, with its name unless `bare`. */
export function ProjectChip({ slug, name, bare = false }: { slug: string; name?: string; bare?: boolean }) {
  return (
    <span className="ui-project" title={bare ? name : undefined}>
      <span className="ui-project-mark" style={{ background: projectColor(slug) }} aria-hidden />
      {!bare && name}
    </span>
  );
}

export interface TabItem<K extends string> {
  key: K;
  label: ReactNode;
  /** A tab that is a link (a filter in the address) rather than a button. */
  href?: string;
}

/**
 * A segmented control: an agent's tabs, a list's choices. One
 * stop of the Tab key (THE-891): the arrows, Home and End move between its
 * tabs, Enter or Space picks one. `controls` names what the tabs show (the
 * agent's activity, files and attachments).
 */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
  push = false,
  controls,
  prefetch = true,
}: {
  items: TabItem<K>[];
  value: K;
  onChange?: (key: K) => void;
  label: string;
  /** Link tabs that open pages (the organization's) add to the history; filters replace it. */
  push?: boolean;
  controls?: string;
  /** Off for filters of a page rendered on the server (/insights): each prefetch would render it. */
  prefetch?: boolean;
}) {
  const stop = Math.max(
    0,
    items.findIndex((it) => it.key === value),
  );
  return (
    <div
      className="ui-tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[role='tab']"));
        const at = tabs.indexOf(e.target as HTMLElement);
        if (at < 0) return;
        if (e.key === " " && tabs[at]?.tagName === "A") {
          e.preventDefault();
          tabs[at]?.click();
          return;
        }
        const next = tabStep(e.key, at, tabs.length);
        if (next === null) return;
        e.preventDefault();
        tabs[next]?.focus();
      }}
    >
      {items.map((it, k) => {
        const body = <>{it.label}</>;
        const on = it.key === value;
        const roving = { tabIndex: k === stop ? 0 : -1, "aria-controls": on ? controls : undefined };
        return it.href ? (
          <Link
            key={it.key}
            href={it.href}
            prefetch={prefetch}
            replace={!push}
            scroll={push}
            role="tab"
            aria-selected={on}
            className="ui-tab"
            onClick={() => onChange?.(it.key)}
            {...roving}
          >
            {body}
          </Link>
        ) : (
          <button
            key={it.key}
            type="button"
            role="tab"
            aria-selected={on}
            className="ui-tab"
            onClick={() => onChange?.(it.key)}
            {...roving}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}

/** What a page shows when it has nothing (a session or a project not on the dashboard): one sentence, then what to do. */
export function EmptyState({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  return (
    <div className="ui-empty">
      <p className="ui-empty-title">{title}</p>
      {hint && <p className="ui-empty-hint">{hint}</p>}
    </div>
  );
}

/**
 * Text the clock changes, in a box as wide as the widest it can read
 * (`widest`, drawn unseen in the same cell, in the same font): a new reading
 * moves nothing beside it. Each reading is a node of its own (keyed here, or
 * by `RelativeTime`): text that moves inside its box counts as a layout
 * shift, a new node does not (THE-982).
 */
export function Steady({ widest, children }: { widest: string[]; children: ReactNode }) {
  return (
    <span className="ui-steady">
      {widest.map((w) => (
        <span key={w} className="ui-steady-ghost" aria-hidden>
          {w}
        </span>
      ))}
      <span key={typeof children === "string" ? children : undefined} className="ui-steady-now">
        {children}
      </span>
    </span>
  );
}

/** A time from now, ticking: "il y a 12 min" (ago), "12 min" (duration). */
export function RelativeTime({ at, format = "ago" }: { at: string | null; format?: "ago" | "duration" }) {
  const { t } = useShell();
  const now = useNow();
  if (!at) return <span className="tnum">—</span>;
  const ms = Math.max(0, now - Date.parse(at));
  const text = format === "ago" ? t.ago(ms) : t.duration(ms);
  // A new node for each reading: text moving where it stands counts as a layout shift (THE-982).
  return (
    <time key={text} className="tnum" dateTime={at} title={new Date(at).toLocaleString()}>
      {text}
    </time>
  );
}

/** A keyboard key, as the hints show it. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
