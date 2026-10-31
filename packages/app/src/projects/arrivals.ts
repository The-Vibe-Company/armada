// The projects added while the app is open (THE-2081): their sidebar line,
// the project's card, fades in once. Those of the daemon's first list were
// there before the window opened and never do.
import { useMemo, useRef } from "react";

/** The ids of `projects` not in the first list this window read. */
export function useArrivals(projects: readonly { id: string }[] | null): ReadonlySet<string> {
  const first = useRef<ReadonlySet<string> | null>(null);
  // Set once, from the first list; a reconnect's list is not a first one.
  if (projects && first.current === null) first.current = new Set(projects.map((p) => p.id));
  const known = first.current;
  return useMemo(() => new Set((projects ?? []).filter((p) => !known?.has(p.id)).map((p) => p.id)), [projects, known]);
}
