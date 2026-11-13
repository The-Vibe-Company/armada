"use client";

import { useSyncExternalStore } from "react";
import { Kbd } from "@/components/ui/kbd";
import { modifierKey } from "@/lib/command-menu";

const subscribe = () => () => {};

/**
 * The shortcut modifier of the viewer's platform (⌘ or Ctrl). The server renders ⌘ and the browser corrects it after
 * hydration, so the markup matches and the label is right.
 */
export function ModKey() {
  return useSyncExternalStore(
    subscribe,
    () => modifierKey(navigator.platform),
    () => "⌘",
  );
}

/** The primary submit shortcut; hidden from the button's accessible name. */
export function SubmitShortcut() {
  return (
    <Kbd
      aria-hidden="true"
      className="-mr-1 ml-0.5 border-transparent bg-primary-foreground/15 text-primary-foreground/80 shadow-none max-sm:hidden"
    >
      <span>
        <ModKey />
      </span>
      <span>↵</span>
    </Kbd>
  );
}
