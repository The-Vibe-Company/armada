"use client";

// The shared components of the v4 dashboard (THE-866). The four screens build
// on these, and on the tokens of globals.css, instead of their own; /design
// shows each one in its states. Styles are the `ui-*` classes of globals.css.
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
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

/** One figure of a KPI row. */
export function Kpi({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <div className="ui-kpi">
      <span className="ui-kpi-label">{label}</span>
      <span className="ui-kpi-value" style={tone ? { color: TONE_COLOR[tone] } : undefined}>
        {value}
      </span>
    </div>
  );
}

export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="ui-kpis">{children}</div>;
}

/** A section's title with its count, and what goes on its right. */
export function SectionHeader({
  title,
  count,
  children,
  as: Heading = "h2",
}: {
  title: ReactNode;
  count?: ReactNode;
  children?: ReactNode;
  as?: "h1" | "h2" | "h3";
}) {
  return (
    <div className="ui-section-h">
      <Heading>{title}</Heading>
      {count !== undefined && <span className="ui-count">{count}</span>}
      {children && <span className="ui-section-side">{children}</span>}
    </div>
  );
}

/**
 * A row of a list that opens a page. j/k moves through the rows of the page,
 * Enter opens the selected one (the shell's keyboard), and the page behind it
 * is prefetched, so opening it never waits for the server.
 */
export function Row({
  href,
  children,
  className,
  style,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Link href={href} prefetch className={cx("ui-row", className)} style={style} data-row="">
      {children}
    </Link>
  );
}

/** A list of rows in a bordered box. */
export function RowList({ children }: { children: ReactNode }) {
  return <div className="ui-rows">{children}</div>;
}

/** A grouped list's band: an icon, a label and a count; sticks to the top while its rows scroll. */
export function GroupHeader({ icon, label, count }: { icon?: ReactNode; label: ReactNode; count?: ReactNode }) {
  return (
    <div className="ui-group-h">
      {icon}
      <span className="ui-group-label">{label}</span>
      {count !== undefined && <span className="ui-count">{count}</span>}
    </div>
  );
}

/** A raised card; a link when `href` is set. */
export function Card({ children, href, className }: { children: ReactNode; href?: string; className?: string }) {
  if (href)
    return (
      <Link href={href} prefetch className={cx("ui-card is-link", className)}>
        {children}
      </Link>
    );
  return <div className={cx("ui-card", className)}>{children}</div>;
}

export interface PanelRow {
  k: ReactNode;
  v: ReactNode;
  dot?: string;
  mono?: boolean;
  tone?: Tone;
}

/** A side panel group: a title over key/value rows, as an agent's or a project's inspector. */
export function SidePanel({ title, rows }: { title: ReactNode; rows: PanelRow[] }) {
  return (
    <section className="ui-panel">
      <h3 className="ui-panel-title">{title}</h3>
      <dl className="ui-panel-rows">
        {rows.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and static.
          <div className="ui-panel-row" key={i}>
            <dt className="ui-panel-k">{r.k}</dt>
            <dd
              className={r.mono ? "ui-panel-v mono" : "ui-panel-v"}
              style={r.tone ? { color: TONE_COLOR[r.tone] } : undefined}
            >
              {r.dot && <Dot color={r.dot} />}
              <span className="ui-ellipsis">{r.v}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
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
