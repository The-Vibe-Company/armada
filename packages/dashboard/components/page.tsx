// The page kit (THE-876): the only way to build a page of the shell. It is
// the Agents page's anatomy, taken apart: the shell draws the header bar
// (`PageHeader`, the page's only title; a page adds buttons to it with
// `HeaderActions`), then a page is its `StatusHeader` (THE-899: where things
// stand, in one sentence of display type), an optional `Toolbar` and its
// `Section`s, each a band over `Row`s, with `Card`s where the design draws
// cards. /design shows each one; test/page-anatomy.test.ts keeps every page
// to it.
//
// Server-safe: the organization's pages render these on the server. The parts
// that need the shell (the header's slot, the density) are in page-client.tsx.
import Link from "next/link";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  FormHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from "react";

export { DensityToggle, HeaderActions, PageHeader } from "./page-client";

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/**
 * From how many rows (or cards) a list is long (THE-892): `long` sections and
 * card grids let the browser skip the style, layout and paint of what is off
 * screen (`content-visibility`), while every row stays in the page for j/k,
 * find and screen readers.
 */
export const LONG_LIST = 100;

/** A page under the header bar: its status, its toolbar, if it has one, then its sections, full width. */
export function Page({ status, toolbar, children }: { status?: ReactNode; toolbar?: ReactNode; children: ReactNode }) {
  return (
    <div className="ui-page">
      {status}
      {toolbar}
      {children}
    </div>
  );
}

/**
 * Where things stand, first (THE-899): one sentence in display type, its
 * quieter second half in `then` ("11 agents in flight. 4 wait for you."), a
 * line of facts, and `Stat` chips that open what they count. `kicker` goes
 * above the sentence (an agent's phase), `aside` on its left (a project's
 * ring). Rendered with the page, never after a fetch: it is most pages'
 * largest paint (THE-892). A paragraph, not a heading: the header bar's h1
 * names the page (THE-891).
 */
export function StatusHeader({
  lead,
  then,
  line,
  stats,
  kicker,
  aside,
}: {
  lead: ReactNode;
  then?: ReactNode;
  line?: ReactNode;
  stats?: ReactNode;
  kicker?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className={cx("ui-status-head", aside !== undefined && "has-aside")}>
      {aside}
      <div className="ui-status-main">
        {kicker && <div className="ui-status-kicker">{kicker}</div>}
        <p className="ui-display">
          {lead}
          {then && (
            <>
              {" "}
              <span className="ui-display-then">{then}</span>
            </>
          )}
        </p>
        {line && <p className="ui-status-line">{line}</p>}
        {stats && <div className="ui-stats">{stats}</div>}
      </div>
    </div>
  );
}

/** One meaning per hue (THE-899): yours to decide, failing, silent, done, in flight. */
export type Hue = "yours" | "fail" | "silent" | "done" | "flight";

/**
 * A figure of a page's status, as a chip: its count in Geist Mono, in its hue
 * with a dot when it matters, and its label; a link to what it counts with `href`.
 */
export function Stat({
  value,
  label,
  hue,
  href,
  prefetch = true,
  children,
}: {
  value?: ReactNode;
  label?: ReactNode;
  hue?: Hue;
  href?: string;
  /** Off for a page rendered on the server from Postgres (/insights). */
  prefetch?: boolean;
  /** What follows the label (a trend). */
  children?: ReactNode;
}) {
  const body = (
    <>
      {hue && <span className="ui-stat-dot" aria-hidden />}
      {value !== undefined && <b>{value}</b>}
      {label}
      {children}
    </>
  );
  const className = cx("ui-stat", hue && `is-${hue}`);
  return href ? (
    <Link href={href} prefetch={prefetch} className={className}>
      {body}
    </Link>
  ) : (
    <span className={className}>{body}</span>
  );
}

/**
 * A reading that failed, said at the top of the page (THE-899): the page keeps
 * its last reading under it, `children` says what failed and since when, and
 * `action` offers to try again.
 */
export function Alert({
  tone = "critical",
  title,
  children,
  action,
}: {
  tone?: "critical" | "warn";
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`ui-alert is-${tone}`} role={tone === "critical" ? "alert" : "status"}>
      <span className="ui-alert-glyph" aria-hidden />
      <p className="ui-alert-text">
        <b>{title}</b>
        {children && <> {children}</>}
      </p>
      {action && <span className="ui-alert-action">{action}</span>}
    </div>
  );
}

/** Lines standing in for a page's status while it loads: a display line and a quiet one. */
export function SkeletonStatus() {
  return (
    <div className="ui-status-head" aria-hidden>
      <div className="ui-status-main">
        <span className="ui-skel is-display" style={{ width: "min(520px, 80%)" }} />
        <span className="ui-skel" style={{ width: "min(380px, 60%)" }} />
      </div>
    </div>
  );
}

/** Rows standing in for a list while it loads, as tall as the rows they stand for. */
export function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders, never reordered.
        <div key={i} className="ui-row is-static ui-skel-row">
          <span className="ui-skel is-round" />
          <span className="ui-skel" style={{ width: 44 }} />
          <span className="ui-skel" style={{ width: `${40 + ((i * 17) % 35)}%` }} />
          <span className="spacer" />
          <span className="ui-skel" style={{ width: 80 }} />
        </div>
      ))}
    </div>
  );
}

/** A progress ring (a project's done tickets): `value` from 0 to 1, its percent inside unless `bare`. */
export function Ring({
  value,
  size = 40,
  stroke = 3,
  color = "var(--done)",
  bare = false,
  label,
}: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  bare?: boolean;
  /** Read by screen readers; decorative without it. */
  label?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, value));
  return (
    <span
      className="ui-ring"
      style={{ width: size, height: size, fontSize: size >= 56 ? 13 : 11 }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <svg width={size} height={size} aria-hidden className="ui-ring-svg">
        <circle className="ui-ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * p} ${c}`}
        />
      </svg>
      {!bare && <b className="ui-ring-n">{Math.round(p * 100)}</b>}
    </span>
  );
}

/** A small trend line under a figure: the values in order, gaps (null) left out. */
export function Sparkline({ values, color = "var(--frontier)" }: { values: (number | null)[]; color?: string }) {
  const v = values.filter((x): x is number => x !== null);
  if (v.length < 2) return <span className="ui-spark" aria-hidden />;
  const max = Math.max(...v);
  const min = Math.min(...v);
  const points = v.map((y, i) => `${(i / (v.length - 1)) * 100},${26 - ((y - min) / (max - min || 1)) * 22}`).join(" ");
  return (
    <svg className="ui-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Big figures side by side on one instrument (Insights). */
export function Figures({ children }: { children: ReactNode }) {
  return <div className="ui-figures">{children}</div>;
}

/**
 * A big figure (THE-899): its label, its value in Geist Mono 32 px (`unit` in
 * small grey type after it), a line under it, and its trend line; a link with `href`.
 */
export function Figure({
  label,
  value,
  sub,
  spark,
  href,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  spark?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <span className="ui-figure-label">{label}</span>
      <span className="ui-figure-value">{value}</span>
      {sub && <span className="ui-figure-sub">{sub}</span>}
      {spark}
    </>
  );
  return href ? (
    <Link href={href} prefetch={false} className="ui-figure">
      {body}
    </Link>
  ) : (
    <div className="ui-figure">{body}</div>
  );
}

/** A unit after a figure's number: "5<Unit>h</Unit>21". */
export function Unit({ children }: { children: ReactNode }) {
  return <small className="ui-unit">{children}</small>;
}

/**
 * The row of tabs and filters under the header bar, with what goes on its
 * right (the density toggle) in `end`. Leave it out when a page has none.
 */
export function Toolbar({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return (
    <div className="ui-toolbar">
      {children}
      {end && <div className="ui-toolbar-end">{end}</div>}
    </div>
  );
}

/**
 * A band and what it holds: an icon or a status dot, a label, a count and
 * what goes on its right (a figure, a hint, an action). Rows go straight
 * inside; anything else goes in a `SectionBody`. `id` lets a link open the
 * page on it (`/agents#error`). `long` for a list over `LONG_LIST` rows.
 */
export function Section({
  id,
  icon,
  label,
  count,
  side,
  long = false,
  children,
}: {
  id?: string;
  icon?: ReactNode;
  label: ReactNode;
  count?: ReactNode;
  side?: ReactNode;
  long?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className={cx("ui-section", long && "is-long")} id={id}>
      <div className="ui-section-h">
        {icon && <span className="ui-section-icon">{icon}</span>}
        <h2 className="ui-section-label">{label}</h2>
        {count !== undefined && <span className="ui-count">{count}</span>}
        {side && <span className="ui-section-side">{side}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * Two columns of sections on a wide screen, one under the other on a narrow
 * one: the page's sections on the left, `side` (facts, a closing action) on
 * the right. Each column holds `Section`s and their `Row`s, nothing else.
 */
export function Columns({ children, side }: { children: ReactNode; side: ReactNode }) {
  return (
    <div className="ui-columns">
      <div className="ui-columns-main">{children}</div>
      <div className="ui-columns-side">{side}</div>
    </div>
  );
}

/** Two sections side by side on a wide screen, one under the other on a narrow one (Insights). */
export function Pair({ children }: { children: ReactNode }) {
  return <div className="ui-pair">{children}</div>;
}

/** What a section holds that is not rows (a form, a hint, cards), on the rows' left edge. */
export function SectionBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("ui-section-body", className)}>{children}</div>;
}

/**
 * A line of a list: 40 px compact, 48 px airy, a hairline under it. With
 * `href` it opens a page: j/k moves through these, Enter opens the selected
 * one, and its page is prefetched. Without, it is a static line (a member, a
 * key, a ticket ready to start).
 */
export function Row({
  href,
  children,
  className,
  style,
  prefetch = true,
}: {
  href?: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Off for a link to the same page (a filter, `?show=`): its prefetch would render the page again. */
  prefetch?: boolean;
}) {
  if (href)
    return (
      <Link href={href} prefetch={prefetch} className={cx("ui-row", className)} style={style} data-row="">
        {children}
      </Link>
    );
  return (
    <div className={cx("ui-row is-static", className)} style={style}>
      {children}
    </div>
  );
}

/** A row's first column, as wide as a status dot: a dot, a project's square, or empty to keep the columns. */
export function RowIcon({ children }: { children?: ReactNode }) {
  return <span className="ui-row-icon">{children}</span>;
}

/** A row's id column, in Geist Mono and one width, so titles line up. */
export function RowId({ children }: { children: ReactNode }) {
  return <span className="ui-row-id">{children}</span>;
}

/** A row's title and the grey line after it; the line gives way first. */
export function RowText({ title, line, lineColor }: { title: ReactNode; line?: ReactNode; lineColor?: string }) {
  return (
    <span className="ui-row-text">
      <span className="ui-row-title">{title}</span>
      {line && (
        <span className="ui-row-line" style={lineColor ? { color: lineColor } : undefined}>
          {line}
        </span>
      )}
    </span>
  );
}

/**
 * What a row shows on its right, before its time: a tag, a figure, an
 * action. `width` fixes the column, so it lines up from row to row; `roomy`
 * hides it on narrow screens.
 */
export function RowSide({ children, roomy = false, width }: { children: ReactNode; roomy?: boolean; width?: number }) {
  return (
    <span className={cx("ui-row-side", roomy && "is-roomy")} style={width ? { width } : undefined}>
      {children}
    </span>
  );
}

/** A row's time or figure on the far right, in Geist Mono. */
export function RowTime({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span className="ui-row-time" style={color ? { color } : undefined}>
      {children}
    </span>
  );
}

/** A status line at the top of a page or section: the data is unreachable, a form was refused or done. */
export function Notice({
  tone = "neutral",
  children,
}: {
  tone?: "critical" | "warn" | "done" | "neutral";
  children: ReactNode;
}) {
  return (
    <div className={`ui-row is-static ui-notice is-${tone}`} role={tone === "critical" ? "alert" : "status"}>
      <span className="ui-notice-dot" aria-hidden />
      <span className="ui-notice-text">{children}</span>
    </div>
  );
}

/** Cards side by side, in a section: the overview's decisions and projects. */
export function CardGrid({
  children,
  wide = false,
  thirds = false,
  long = false,
  className,
}: {
  children: ReactNode;
  className?: string;
  wide?: boolean;
  /** Three across a desk's page: the projects. */
  thirds?: boolean;
  /** Over `LONG_LIST` cards. */
  long?: boolean;
}) {
  return (
    <div className={cx("ui-cards", wide && "is-wide", thirds && "is-thirds", long && "is-long", className)}>
      {children}
    </div>
  );
}

/** A card: an instrument on the deck; a link when `href` is set, which j/k moves through like a row. */
export function Card({
  children,
  href,
  className,
  prefetch = true,
  external = false,
}: {
  children: ReactNode;
  href?: string;
  className?: string;
  /** As a row's. */
  prefetch?: boolean;
  /** Another site's page: it opens in a new tab, as Enter on the row does. */
  external?: boolean;
}) {
  if (href)
    return (
      <Link
        href={href}
        prefetch={prefetch}
        className={cx("ui-card is-link", className)}
        data-row=""
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {children}
      </Link>
    );
  return <div className={cx("ui-card", className)}>{children}</div>;
}

/** A card's title, on the rows' type scale. */
export function CardTitle({ children }: { children: ReactNode }) {
  return <div className="ui-card-title">{children}</div>;
}

/** A card's grey line of facts: a project, an id, a person. */
export function CardMeta({ children }: { children: ReactNode }) {
  return <div className="ui-card-meta">{children}</div>;
}

/** A card's first line: an icon or dot, a label in its color, and what goes on the right (an age). */
export function CardHead({
  icon,
  label,
  side,
  color,
}: {
  icon?: ReactNode;
  label: ReactNode;
  side?: ReactNode;
  color?: string;
}) {
  return (
    <div className="ui-card-head">
      {icon}
      <span className="ui-card-kind" style={color ? { color } : undefined}>
        {label}
      </span>
      {side && <span className="ui-card-side">{side}</span>}
    </div>
  );
}

/**
 * A form on one line, its fields then its buttons, wrapping on narrow
 * screens: invite someone, save a key, link an installation. `grow` lets its
 * fields take the room they are given (a row's right, a section's width).
 */
export function Form({ className, grow = false, ...props }: FormHTMLAttributes<HTMLFormElement> & { grow?: boolean }) {
  return <form {...props} className={cx("ui-form", grow && "is-grow", className)} />;
}

/**
 * The mockup's buttons: plain on a fill, `primary` light on dark (the submit),
 * `danger` in red text, `quiet` without a fill; `small` in a card or a band.
 */
export function Button({
  tone,
  small = false,
  className,
  type = "submit",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "danger" | "quiet";
  small?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button {...props} type={type} className={cx("ui-button", tone && `is-${tone}`, small && "is-small", className)} />
  );
}

/** A text field on the buttons' height; give it a label, visible or `sr-only`. */
export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input {...props} className={cx("ui-input", className)} />;
}

/** A choice on the buttons' height: a role. */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx("ui-input ui-select", className)} />;
}
