"use client";

// The fleet, live (THE-887): the dashboard's own overview (components/Fleet.tsx,
// its decision cards and its live timeline) drawn from the demo world's
// overview, built at build time, in a window. It plays replica-script.ts: a
// pointer answers a question, the coordinator delivers it and the worker goes
// back to work, then a hand-back arrives; the clock runs fifteen times faster,
// so the timeline moves. It plays only while on screen; it is inert (nothing
// in it can be clicked or focused) and reads nothing from any server.
import type { FleetOverview } from "@armada/core/read";
// The context Next's Link reads its router from: without one, a Link prefetches nothing (see below).
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { Fleet } from "@/components/Fleet";
import { HeaderSlotProvider, PageHeader } from "@/components/page-client";
import { ShowcaseProvider } from "@/components/shell/context";
import { prefersReducedMotion, whileVisible } from "./frames";
import { Mark } from "./Mark";
import { ANSWER, answered, delivered, handedBack, OWNER, opening } from "./replica-script";

/** The replica's clock runs this many times faster than the viewer's. */
const SPEED = 15;
/** The beats, in seconds from the start of a loop. */
const BEATS = { point: 2.2, press: 3.3, deliver: 6.6, handBack: 9.6, loop: 15.5 };

/** The demo world's owner, signed in: requests are signed with her name. */
const VIEWER = {
  name: OWNER,
  email: "lea@acme.example",
  organization: { id: "acme", name: "Acme" },
  organizations: [{ id: "acme", name: "Acme" }],
};

type Stage = "opening" | "answered" | "delivered" | "handed-back";

export function Replica({ base }: { base: FleetOverview }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = Date.parse(base.generatedAt);
  const first = useMemo(() => opening(base), [base]);
  const [shown, setShown] = useState<{ overview: FleetOverview; now: number; stage: Stage }>({
    overview: first,
    now: start,
    stage: "opening",
  });
  const [pointer, setPointer] = useState<{ x: number; y: number; on: boolean; press: boolean } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    let tick: ReturnType<typeof setInterval> | null = null;
    let loopStart = 0;
    let overview = first;

    const at = (seconds: number, run: () => void) => timers.push(setTimeout(run, seconds * 1000));
    const clock = () => start + ((performance.now() - loopStart) / 1000) * SPEED * 1000;
    const show = (next: FleetOverview, stage: Stage) => {
      overview = next;
      setShown({ overview: next, now: clock(), stage });
    };

    /** Where the answer's button is, in the replica's coordinates. */
    const target = () => {
      const button = [...el.querySelectorAll<HTMLButtonElement>("button.btn")].find((b) =>
        b.textContent?.includes(ANSWER.split(" (")[0] ?? ANSWER),
      );
      if (!button) return null;
      const r = el.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      return { x: b.left - r.left + b.width * 0.6, y: b.top - r.top + b.height * 0.62, button };
    };

    const play = () => {
      loopStart = performance.now();
      show(first, "opening");
      setPointer(null);
      tick = setInterval(() => setShown((s) => ({ ...s, now: clock() })), 1000);
      at(BEATS.point, () => {
        const t = target();
        if (t) setPointer({ x: t.x, y: t.y, on: true, press: false });
      });
      at(BEATS.press, () => {
        const t = target();
        t?.button.setAttribute("data-pressed", "");
        setPointer((p) => (p ? { ...p, press: true } : p));
        at(0.18, () => {
          t?.button.removeAttribute("data-pressed");
          show(answered(overview, clock()), "answered");
          setPointer((p) => (p ? { ...p, press: false } : p));
        });
        at(0.9, () => setPointer((p) => (p ? { ...p, on: false } : p)));
      });
      at(BEATS.deliver, () => show(delivered(overview, clock()), "delivered"));
      at(BEATS.handBack, () => show(handedBack(overview, base, clock()), "handed-back"));
      at(BEATS.loop, () => {
        stop();
        play();
      });
    };
    const stop = () => {
      for (const t of timers) clearTimeout(t);
      timers = [];
      for (const b of el.querySelectorAll("[data-pressed]")) b.removeAttribute("data-pressed");
      if (tick) clearInterval(tick);
      tick = null;
    };
    const unwatch = whileVisible(el, (on) => (on ? play() : stop()), "-10% 0px");
    return () => {
      unwatch();
      stop();
    };
  }, [base, first, start]);

  return (
    <div className="lp-replica" ref={ref} data-stage={shown.stage}>
      <div className="lp-replica-window" inert>
        <div className="lp-replica-rail" aria-hidden>
          <Mark size={20} />
          <span className="lp-replica-nav is-on" />
          <span className="lp-replica-nav" />
          <span className="lp-replica-nav" />
          <span className="lp-replica-nav" />
        </div>
        <div className="sh-main lp-replica-main" data-density="compact">
          {/* No router: the replica's links (agents, projects) never prefetch the real pages, which
              would send a signed-out visitor's browser through the sign-in gate for nothing. */}
          <AppRouterContext.Provider value={null}>
            <ShowcaseProvider overview={shown.overview} now={shown.now} account={VIEWER}>
              <HeaderSlotProvider>
                <PageHeader title={<span className="lp-replica-crumb">Overview</span>} />
                <div className="lp-replica-scroll">
                  <Fleet />
                </div>
              </HeaderSlotProvider>
            </ShowcaseProvider>
          </AppRouterContext.Provider>
        </div>
      </div>
      {pointer && (
        <span
          className="lp-pointer"
          data-on={pointer.on || undefined}
          data-press={pointer.press || undefined}
          style={{ transform: `translate(${pointer.x}px, ${pointer.y}px)` }}
          aria-hidden
        >
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden className="lp-pointer-arrow">
            <path
              d="M4 2.5l11.5 9.2-5.2.6 3 6.1-2.3 1.1-3-6.1L4 17z"
              fill="#f0efec"
              stroke="#09090b"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
    </div>
  );
}
