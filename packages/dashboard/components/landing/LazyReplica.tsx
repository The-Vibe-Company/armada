"use client";

// The replica of the fleet, loaded as it nears the screen (THE-887): its code
// (the dashboard's overview and its strings) and the demo world's overview
// come then, not with the landing's first paint. Until then, an empty window
// of the same size holds its place, so nothing moves when it arrives.
import type { FleetOverview } from "@armada/core/read";
import { type ComponentType, useEffect, useRef, useState } from "react";

type Loaded = { Replica: ComponentType<{ base: FleetOverview }>; base: FleetOverview };

export function LazyReplica() {
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        void Promise.all([
          import("./Replica"),
          fetch("/landing/fleet.json").then((r) => r.json() as Promise<FleetOverview>),
        ])
          .then(([m, base]) => live && setLoaded({ Replica: m.Replica, base }))
          .catch(() => {
            // The replica is a showcase: without it, the empty window stays.
          });
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, []);

  if (loaded) return <loaded.Replica base={loaded.base} />;
  return (
    <div className="lp-replica" ref={ref}>
      <div className="lp-replica-window" aria-hidden>
        <div className="lp-replica-rail" />
        <div className="sh-main lp-replica-main" />
      </div>
    </div>
  );
}
