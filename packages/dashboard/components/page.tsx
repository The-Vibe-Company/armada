// The page kit (THE-876, THE-1021): what every page of the shell shares
// besides its own blocks. The shell draws the header bar (`PageHeader`, the
// page's only title; a page adds buttons to it with `HeaderActions`); a page
// says a failed reading with `Alert` and a quieter fact with `Notice`, builds
// its forms from `Form`, `Input`, `Select` and `Button`, and stands in
// `PageSkeleton` while it loads. test/page-anatomy.test.ts keeps every page
// to it.
//
// Server-safe: the organization's pages render these on the server. The parts
// that need the shell (the header's slot) are in page-client.tsx.
import type {
  ButtonHTMLAttributes,
  FormHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from "react";

export { HeaderActions, PageHeader } from "./page-client";

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/**
 * From how many rows a list is long (THE-892): a long list lets the browser
 * skip the style, layout and paint of what is off screen
 * (`content-visibility`), while every row stays in the page for j/k, find
 * and screen readers.
 */
export const LONG_LIST = 100;

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

/** A page standing in while it loads (THE-899): its title, its line and its rows, in their places. */
export function PageSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="pg" aria-hidden>
      <div className="pg-head">
        <span className="ui-skel is-title" style={{ width: 160 }} />
        <span className="ui-skel" style={{ width: "min(420px, 70%)" }} />
      </div>
      <div className="ui-skel-rows">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders, never reordered.
          <span key={i} className="ui-skel-row">
            <span className="ui-skel" style={{ width: 44 }} />
            <span className="ui-skel" style={{ width: `${40 + ((i * 17) % 35)}%` }} />
          </span>
        ))}
      </div>
    </div>
  );
}

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
