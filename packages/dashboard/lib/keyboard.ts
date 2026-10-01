// The keyboard's rules the shell and the page kit share (THE-891). Pure: they
// read an element's tag and place, or a key, never the page.

/** What `ownsKeys` reads of an element: a DOM element, or a stand-in in a test. */
export interface KeyTarget {
  tagName: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** Where a key belongs to its element: a text field, a choice, an editable block, an open dialog. */
const OWNER = "dialog[open], [role='dialog'], [contenteditable='true']";

/**
 * Keys typed in a field, or in a dialog, belong to it: j, k, Enter and Esc
 * never leave a text box or reach the page behind a dialog.
 */
export function ownsKeys(target: unknown): boolean {
  const el = target as KeyTarget | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
  return typeof el.closest === "function" && !!el.closest(OWNER);
}

/** Where an arrow key, Home or End moves the focus in a row of `count` tabs; null for any other key. */
export function tabStep(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (at + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (at - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
