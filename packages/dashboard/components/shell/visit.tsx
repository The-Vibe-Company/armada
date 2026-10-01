"use client";

// The viewer's visit, as the shell keeps it (THE-894). A beacon to
// `/api/fleet/visit` on load, when the tab comes back and every five minutes
// while it is shown records that they are here and brings back where "since
// you were away" starts (the overview reads the summary) and their
// notification settings. Nothing runs while the tab is hidden. Pages read it
// with `useVisit`, which is null outside the shell (the landing's replica).
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ZONE_COOKIE } from "@/lib/activity-view";
import type { NotifySettings, VisitAnswer } from "@/lib/notify";

const BEAT_MS = 5 * 60_000;

export interface VisitState {
  /** Null until the first beacon answers. */
  answer: VisitAnswer | null;
  /** Hides the summary until the next visit. */
  dismiss: () => void;
  setNotify: (notify: NotifySettings) => void;
}

const VisitContext = createContext<VisitState | null>(null);

/** The viewer's time zone, kept for the pages the server renders (the Activity page's days and times). */
function rememberZone() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || document.cookie.split("; ").includes(`${ZONE_COOKIE}=${encodeURIComponent(zone)}`)) return;
  // biome-ignore lint/suspicious/noDocumentCookie: a plain preference cookie, read by the server on the next load.
  document.cookie = `${ZONE_COOKIE}=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax`;
}

export function VisitProvider({ children }: { children: ReactNode }) {
  const [answer, setAnswer] = useState<VisitAnswer | null>(null);
  /** The last request sent: an older one's answer (a beat sent before a dismiss) is dropped. */
  const sent = useRef(0);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const mine = ++sent.current;
    try {
      const res = await fetch("/api/fleet/visit", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const next = res.ok ? ((await res.json()) as VisitAnswer) : null;
      if (next && mine === sent.current) setAnswer(next);
    } catch {
      // A nicety: the dashboard stands without it.
    }
  }, []);

  useEffect(() => {
    rememberZone();
    const beat = () => {
      if (document.visibilityState === "visible") void post({});
    };
    beat();
    const timer = setInterval(beat, BEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", beat);
    };
  }, [post]);

  const value = useMemo<VisitState>(
    () => ({
      answer,
      dismiss: () => {
        if (!answer?.since) return;
        setAnswer({ ...answer, since: null });
        void post({ dismiss: answer.since });
      },
      setNotify: (notify) => {
        setAnswer((a) => (a ? { ...a, notify } : { since: null, notify }));
        void post({ notify });
      },
    }),
    [answer, post],
  );
  return <VisitContext.Provider value={value}>{children}</VisitContext.Provider>;
}

/** The viewer's visit; null outside the shell. */
export const useVisit = () => useContext(VisitContext);
