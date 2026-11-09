"use client";

// The replica of the fleet, loaded as it nears the screen (THE-887): its code
// comes then, not with the landing's first paint. Until then, an empty window
// of the same size holds its place, so nothing moves when it arrives. Restored
// by #564: the replica now carries its own static data, so nothing is fetched.
import { type ComponentType, useEffect, useRef, useState } from "react";

export function LazyReplica() {
  const ref = useRef<HTMLDivElement>(null);
  const [Replica, setReplica] = useState<ComponentType | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        void import("./Replica")
          .then((m) => live && setReplica(() => m.Replica))
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

  if (Replica) return <Replica />;
  return (
    <div className="lp-replica" ref={ref}>
      <div className="lp-replica-window" aria-hidden>
        <div className="sh-side" />
        <div className="sh-main lp-replica-main" />
      </div>
    </div>
  );
}
