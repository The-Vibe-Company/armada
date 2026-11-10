"use client";

import { useSyncExternalStore } from "react";
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
