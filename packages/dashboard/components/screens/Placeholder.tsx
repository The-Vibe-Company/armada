"use client";

import { useShell } from "../shell/context";

/** The line a placeholder screen carries until its screen ticket replaces it. */
export function PlaceholderNote() {
  const { t } = useShell();
  return <p className="sc-note">{t.shell.placeholder}</p>;
}
