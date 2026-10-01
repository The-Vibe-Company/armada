"use client";

// The shared components of the v4 dashboard (THE-866): the small parts rows
// and cards are made of (status dots, pills, badges, tabs, times). The page's
// anatomy (header, toolbar, sections, rows, cards) is the page kit,
// components/page.tsx. /design shows both; styles are the `ui-*` classes of
// globals.css.
import Link from "next/link";
import type { ReactNode } from "react";
import { type AgentStatus, HARNESS_NAME, type Harness, projectColor } from "@/lib/fleet-view";
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

/** A segmented control: the harness filter, the density, an agent's tabs. */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
  size = "md",
}: {
  items: TabItem<K>[];
  value: K;
  onChange?: (key: K) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={`ui-tabs is-${size}`} role="tablist" aria-label={label}>
      {items.map((it) => {
        const body = (
          <>
            {it.dot && <Dot color={it.dot} />}
            {it.label}
            {it.count !== undefined && <span className="ui-tab-count">{it.count}</span>}
          </>
        );
        const on = it.key === value;
        return it.href ? (
          <Link
            key={it.key}
            href={it.href}
            prefetch
            replace
            scroll={false}
            role="tab"
            aria-selected={on}
            className="ui-tab"
            onClick={() => onChange?.(it.key)}
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
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}

/** What a list or page shows when it has nothing. */
export function EmptyState({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ui-empty">
      <span className="ui-empty-title">{title}</span>
      {hint && <span className="ui-empty-hint">{hint}</span>}
      {children}
    </div>
  );
}

/** A time from now, ticking: "il y a 12 min" (ago), "12 min" (duration). */
export function RelativeTime({ at, format = "ago" }: { at: string | null; format?: "ago" | "duration" }) {
  const { t } = useShell();
  const now = useNow();
  if (!at) return <span className="tnum">—</span>;
  const ms = Math.max(0, now - Date.parse(at));
  return (
    <time className="tnum" dateTime={at} title={new Date(at).toLocaleString()}>
      {format === "ago" ? t.ago(ms) : t.duration(ms)}
    </time>
  );
}

/** The six steps from plan to merge in a small bar; the current one in its tone. */
export function Steps({ step, tone, wide = false }: { step: number; tone: Tone; wide?: boolean }) {
  const { t } = useShell();
  return (
    <span
      className={cx("ui-steps", wide && "is-wide")}
      role="img"
      aria-label={`${t.shell.steps[step] ?? ""} (${step + 1}/${t.shell.steps.length})`}
    >
      {t.shell.steps.map((s, k) => (
        <span
          key={s}
          className="ui-step"
          style={{ background: k < step ? "rgba(240,239,236,.45)" : k === step ? TONE_COLOR[tone] : undefined }}
        />
      ))}
    </span>
  );
}

/** A keyboard key, as the hints show it. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
