// The page kit (THE-876): the only way to build a page of the shell. It is
// the Agents page's anatomy, taken apart: the shell draws the header bar
// (`PageHeader`, the page's only title; a page adds buttons to it with
// `HeaderActions`), then a page is an optional `Toolbar` and its `Section`s,
// each a band over `Row`s, with `Card`s where the design draws cards. /design
// shows each one; test/page-anatomy.test.ts keeps every page to it.
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

/** A page under the header bar: its toolbar, if it has one, then its sections, full width. */
export function Page({ toolbar, children }: { toolbar?: ReactNode; children: ReactNode }) {
  return (
    <div className="ui-page">
      {toolbar}
      {children}
    </div>
  );
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
  long = false,
}: {
  children: ReactNode;
  wide?: boolean;
  /** Over `LONG_LIST` cards. */
  long?: boolean;
}) {
  return <div className={cx("ui-cards", wide && "is-wide", long && "is-long")}>{children}</div>;
}

/** A card: the rows' padding, hairline and type, with a radius; a link when `href` is set. */
export function Card({
  children,
  href,
  className,
  prefetch = true,
}: {
  children: ReactNode;
  href?: string;
  className?: string;
  /** As a row's. */
  prefetch?: boolean;
}) {
  if (href)
    return (
      <Link href={href} prefetch={prefetch} className={cx("ui-card is-link", className)}>
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

/** The mockup's buttons: plain on a fill, `primary` light on dark (the submit), `danger` in red text. */
export function Button({
  tone,
  className,
  type = "submit",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "danger"; ref?: Ref<HTMLButtonElement> }) {
  return <button {...props} type={type} className={cx("ui-button", tone && `is-${tone}`, className)} />;
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
