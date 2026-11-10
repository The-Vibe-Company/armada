/** The keys a keyboard event carries, as far as a shortcut cares. */
export type ShortcutKeys = {
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
