"use client";

// The shell's one polite live region (THE-891). It reads each overview the
// shell polls, waits until the fleet has been still for `QUIET_MS`, then
// says in one sentence what changed since it last spoke (lib/announce.ts): a
// new item waiting for the viewer, a phase change. Nothing on the first
// load, nothing for a poll that changed nothing that matters.
import { useEffect, useRef, useState } from "react";
import { changes, sentence, type Watched, watched } from "@/lib/announce";
import { useFleet, useShell } from "./context";

/** A burst of polls is one announcement, said once the fleet has been still this long. */
const QUIET_MS = 2_000;

export function Announcer() {
  const { t } = useShell();
  const { overview } = useFleet();
  const said = useRef<Watched | null>(null);
  const [message, setMessage] = useState<{ n: number; text: string } | null>(null);

  useEffect(() => {
    const now = watched(overview);
    if (!said.current) {
      said.current = now;
      return;
    }
    const timer = setTimeout(() => {
      const text = sentence(t, changes(said.current ?? now, now));
      said.current = now;
      if (text) setMessage((m) => ({ n: (m?.n ?? 0) + 1, text }));
    }, QUIET_MS);
    return () => clearTimeout(timer);
  }, [overview, t]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {/* A new node each time, so the same sentence twice is said twice. */}
      {message && <span key={message.n}>{message.text}</span>}
    </div>
  );
}
