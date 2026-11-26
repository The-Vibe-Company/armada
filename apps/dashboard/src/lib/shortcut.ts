/** The keys a keyboard event carries, as far as a shortcut cares. */
type ShortcutKeys = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** An input method (Japanese, Chinese…) is composing: its Enter confirms the text, never the form. */
  isComposing?: boolean;
};

/**
 * ⌘↵ (Ctrl+↵ off macOS): submit the form, from any field, as the composer does. A plain Enter keeps its meaning (a
 * new line in the task), and so do Shift, Alt and an input method's Enter.
 */
export function isSubmitShortcut(event: ShortcutKeys): boolean {
  return (
    event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.isComposing
  );
}

type GlobalShortcutEvent = {
  defaultPrevented?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
};

export function shouldIgnoreGlobalShortcut(event: GlobalShortcutEvent, options?: { allowShift?: boolean }) {
  if (event.defaultPrevented || event.repeat || event.isComposing) return true;
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  if (!options?.allowShift && event.shiftKey) return true;
  const target = event.target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  } | null;
  if (target) {
    const tag = target.tagName?.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return true;
    if (typeof target.closest === "function" && target.closest('[contenteditable="true"], [role="textbox"]')) {
      return true;
    }
  }
  if (
    typeof document !== "undefined" &&
    typeof document.querySelector === "function" &&
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"], dialog[open]',
    )
  ) {
    return true;
  }
  return false;
}
