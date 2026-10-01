"use client";

// A piece of a page that loads apart from it (THE-892): its chunk is fetched
// as soon as the browser is idle, and the component renders once it is there,
// without suspending. A suspended boundary is revealed at React's pace (300 ms
// at least), which the click that opens it would wait for.
import { useEffect, useState } from "react";

/** What `load` gives once it resolved, after the browser was idle; null until then, or while `when` is false. */
export function useLazy<T>(load: () => Promise<T>, when = true): T | null {
  const [loaded, setLoaded] = useState<{ value: T } | null>(null);
  useEffect(() => {
    if (!when) return;
    let live = true;
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(() => void load().then((value) => live && setLoaded({ value })));
    return () => {
      live = false;
      cancel(id);
    };
  }, [load, when]);
  return loaded?.value ?? null;
}
