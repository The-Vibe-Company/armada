"use client";

import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { exactLocalTime, relativeAge } from "@/lib/relative-time";

/** Often enough for "min ago" to stay right to the minute. */
const TICK_MS = 30_000;

/**
 * When a sandbox was created, as its age ("5 min ago"), kept current without a reload. Hover or keyboard focus shows
 * the exact moment in the viewer's own time zone. The first render uses the server's `now` so hydration matches the
 * server's HTML; the browser's clock and zone take over once mounted, and only there.
 */
export function CreatedAt({ iso, now }: { iso: string; now: number }) {
  const [current, setCurrent] = useState(now);
  useEffect(() => {
    setCurrent(Date.now());
    const timer = setInterval(() => setCurrent(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const age = relativeAge(iso, current);
  if (age === null) return <span>Unknown</span>;
  return (
    <TooltipProvider>
      <Tooltip>
        {/* A button, so the exact time is reachable from the keyboard as well as by pointer. */}
        <TooltipTrigger className="cursor-default rounded-sm underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <time dateTime={iso}>{age}</time>
        </TooltipTrigger>
        <TooltipContent>{exactLocalTime(iso)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
