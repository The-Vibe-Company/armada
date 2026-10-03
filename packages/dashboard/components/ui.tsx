"use client";

// The shared components of the v4 dashboard (THE-866): the small parts rows
// and cards are made of (status dots, pills, badges, tabs, times). The page's
// anatomy (header, toolbar, sections, rows, cards) is the page kit,
// components/page.tsx. /design shows both; styles are the `ui-*` classes of
// globals.css.
import Link from "next/link";
import type { ReactNode } from "react";
import { type AgentStatus, HARNESS_NAME, type Harness, projectColor } from "@/lib/fleet-view";
import { tabStep } from "@/lib/keyboard";
import { FormationAtRest } from "./mark";
import { useNow, useShell } from "./shell/context";

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/** A tone: an agent status, or plain. */
export type Tone = AgentStatus | "neutral";

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

const TONE_COLOR: Record<Tone, string> = {
  waiting: "var(--accent)",
  error: "var(--critical)",
  silent: "var(--active)",
  running: "var(--frontier)",
  done: "var(--done)",
  neutral: "var(--text-2)",
};

export const toneColor = (tone: Tone) => TONE_COLOR[tone];

/** A phase or status in its tone: "Attend ta réponse", "CI rouge", "Implémentation". */
export function PhasePill({ tone, children, dot = false }: { tone: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`ui-pill is-${tone}`}>
      {dot && <Dot color={TONE_COLOR[tone]} size={6} />}
      {children}
    </span>
  );
}

/** A plain label chip: a ticket label, a project name. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="ui-tag">{children}</span>;
}

export const harnessColor = (h: Harness) => `var(--h-${h})`;

/** The harness a session runs on: its color, and its name unless `bare`. */
export function HarnessBadge({
  harness,
  local = false,
  bare = false,
}: {
  harness: Harness;
  local?: boolean;
  bare?: boolean;
}) {
  const { t } = useShell();
  const name = local ? t.shell.local(HARNESS_NAME[harness]) : HARNESS_NAME[harness];
  return (
    <span className="ui-harness" title={bare ? name : undefined}>
      <Dot color={harnessColor(harness)} />
      {bare ? <span className="sr-only">{name}</span> : name}
    </span>
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

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

/** A person's initials in a circle. */
export function Avatar({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <span className="ui-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.47) }} title={name}>
      {initials(name)}
    </span>
  );
}

export interface TabItem<K extends string> {
  key: K;
  label: ReactNode;
  count?: ReactNode;
  /** A color dot before the label (a harness). */
  dot?: string;
  /** A tab that is a link (a filter in the address) rather than a button. */
  href?: string;
}

/**
 * A segmented control: the harness filter, the density, an agent's tabs. One
 * stop of the Tab key (THE-891): the arrows, Home and End move between its
 * tabs, Enter or Space picks one. `controls` names what the tabs show (the
 * agent's activity, files and attachments).
 */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
  size = "md",
  push = false,
  controls,
  prefetch = true,
}: {
  items: TabItem<K>[];
  value: K;
  onChange?: (key: K) => void;
  label: string;
  size?: "sm" | "md";
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
      className={`ui-tabs is-${size}`}
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
        const body = (
          <>
            {it.dot && <Dot color={it.dot} />}
            {it.label}
            {it.count !== undefined && <span className="ui-tab-count">{it.count}</span>}
          </>
        );
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

/**
 * What a list or page shows when it has nothing (THE-899): the formation at
 * rest, one sentence, what to do next, and its action in `children`.
 * `compact` for a list among others on a page (a settings page): one line,
 * a small formation before it.
 */
export function EmptyState({
  title,
  hint,
  compact = false,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  compact?: boolean;
  children?: ReactNode;
}) {
  if (compact)
    return (
      <div className="ui-empty is-compact">
        <FormationAtRest size={28} />
        <span className="ui-empty-text">
          <span className="ui-empty-title">{title}</span>
          {hint && <span className="ui-empty-hint">{hint}</span>}
        </span>
        {children}
      </div>
    );
  return (
    <div className="ui-empty">
      <FormationAtRest size={104} />
      <span className="ui-empty-title">{title}</span>
      {hint && <span className="ui-empty-hint">{hint}</span>}
      {children && <span className="ui-empty-actions">{children}</span>}
    </div>
  );
}

/** The longest a ticking time reads before it counts days: "59 min", "23 h 59". */
export const LONGEST_TIMES = [59 * 60_000, 24 * 3_600_000 - 60_000];

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
      <span key={typeof children === "string" ? children : undefined}>{children}</span>
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

/** The six steps from plan to merge in a small bar; the current one lit in its tone. */
export function Steps({ step, tone, wide = false }: { step: number; tone: Tone; wide?: boolean }) {
  const { t } = useShell();
  return (
    <span
      className={cx("ui-steps", wide && "is-wide")}
      role="img"
      aria-label={`${t.shell.steps[step] ?? ""} (${step + 1}/${t.shell.steps.length})`}
      style={{ ["--c" as string]: TONE_COLOR[tone] }}
    >
      {t.shell.steps.map((s, k) => (
        <span key={s} className={cx("ui-step", k < step && "is-done", k === step && "is-now")} />
      ))}
    </span>
  );
}

/** A keyboard key, as the hints show it. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
