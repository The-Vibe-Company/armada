// The fleet's sky (THE-2024): the landing's flock as a live picture of the
// fleet, after the direction kept with the owner (`.aeom/direction`,
// "hangar-sky-mix"). One canvas draws the ships (layout.ts places them,
// flock.ts flies them, draw.ts draws them); the words over it, the group or
// project labels and the quiet legend, are HTML, set in Geist. The canvas
// stepping follows the landing's (packages/dashboard/components/landing/Sky.tsx):
// at most two device pixels per CSS pixel, a still sky with reduced motion.
//
// Movement says something: a ship banks and flies to its new group when its
// session changes state, flies to the merged V when its ticket merges (its
// squadron closing ranks), flies in when a session starts and out when it
// ends. Between two changes the sky holds still and asks for no frame.
import { useEffect, useMemo, useRef, useState } from "react";
import { GROUPS, type Group } from "@/fleet/overview";
import { HARNESS_LABEL, HARNESSES, type SkyProject } from "@/fleet/sky";
import { cn } from "@/lib/utils";
import { HARNESS_COLOR, layoutSky, SKY_GROUP_LABEL, type SkyLabel, type SkySize, STATE_COLOR } from "./layout";
import { animationFrames, createSkyView, type SkyClock, type SkyView } from "./view";

export interface SkyProps {
  /** The projects it draws: one for the band (a project's room), any number on the stage (the hangar). */
  projects: readonly SkyProject[];
  /** `band`: about 200 px tall, full width; `stage`: fills its container. */
  size: SkySize;
  /** The frames it steps on; the browser's animation frames unless a test turns its own. */
  clock?: SkyClock;
  /** Overrides the system's reduced-motion setting: with it, the sky changes without flying. */
  reducedMotion?: boolean;
  className?: string;
}

const LABEL_COLOR: Record<Group, string> = {
  blocked: "text-red",
  you: "text-amber",
  running: "text-blue",
  ready: "text-green",
  merged: "text-text-3",
};

function useReducedMotion(given: boolean | undefined): boolean {
  const [system, setSystem] = useState(false);
  useEffect(() => {
    if (given !== undefined || typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setSystem(query.matches);
    const change = () => setSystem(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, [given]);
  return given ?? system;
}

export function Sky({ projects, size, clock = animationFrames, reducedMotion, className }: SkyProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawn = useRef({ width: 0, height: 0 });
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<SkyView | null>(null);
  const still = useReducedMotion(reducedMotion);
  const layout = useMemo(() => layoutSky(projects, size, area.width, area.height), [projects, size, area]);

  useEffect(() => {
    const el = box.current;
    const ctx = canvas.current?.getContext("2d");
    if (!el || !ctx) return;
    const made = createSkyView(ctx, clock);
    // A new view has drawn nothing yet: the effect below sizes it and shows the fleet.
    drawn.current = { width: 0, height: 0 };
    setView(made);
    const measure = () => {
      const r = el.getBoundingClientRect();
      setArea((a) => (a.width === r.width && a.height === r.height ? a : { width: r.width, height: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      made.stop();
      setView(null);
    };
  }, [clock]);

  useEffect(() => {
    const c = canvas.current;
    if (!view || !c || !area.width || !area.height) return;
    // A new size puts every ship in its new place: only the fleet's changes fly.
    const resized = drawn.current.width !== area.width || drawn.current.height !== area.height;
    if (resized) {
      // Two device pixels per CSS pixel at most: sharper costs frames.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = Math.round(area.width * dpr);
      c.height = Math.round(area.height * dpr);
      view.resize(area.width, area.height, dpr);
      drawn.current = area;
    }
    view.show(layout, { still: still || resized });
  }, [view, layout, area, still]);

  const counts = useMemo(() => {
    const groups = { blocked: 0, you: 0, running: 0, ready: 0, merged: 0 } as Record<Group, number>;
    const harnesses = new Set<string>();
    for (const p of projects)
      for (const a of p.agents) {
        groups[a.group]++;
        if (a.harness && a.group !== "merged") harnesses.add(a.harness);
      }
    return { groups, harnesses: HARNESSES.filter((h) => harnesses.has(h)) };
  }, [projects]);

  return (
    <section
      ref={box}
      aria-label={size === "band" ? "This project's agents, grouped by state" : "The fleet's squadrons"}
      data-sky={size}
      className={cn(
        "relative w-full overflow-hidden bg-bg",
        size === "band" ? "h-50 flex-none" : "h-full min-h-105 flex-1",
        className,
      )}
    >
      <canvas ref={canvas} aria-hidden className="absolute inset-0 block h-full w-full" />
      {layout.labels.map((label) => (
        <Label key={label.key} label={label} size={size} />
      ))}
      <div className="pointer-events-none absolute right-6 bottom-3 left-6 flex justify-between gap-6 text-body text-text-3">
        <Legend
          items={GROUPS.map((g) => ({
            key: g,
            label: SKY_GROUP_LABEL[g],
            count: counts.groups[g],
            mark: <span className="size-1.75 rounded-full" style={{ background: STATE_COLOR[g] }} />,
          }))}
        />
        <Legend
          items={counts.harnesses.map((h) => ({
            key: h,
            label: HARNESS_LABEL[h],
            count: null,
            mark: (
              <svg width="10" height="10" viewBox="-6 -6 12 12" aria-hidden>
                <path d="M0 -6 L5.2 5 L-5.2 5 Z" fill={HARNESS_COLOR[h]} />
              </svg>
            ),
          }))}
        />
      </div>
    </section>
  );
}

function Legend({ items }: { items: { key: string; label: string; count: number | null; mark: React.ReactNode }[] }) {
  if (!items.length) return <span />;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-3.5 gap-y-1 p-0" data-legend>
      {items.map((i) => (
        <li key={i.key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {i.mark}
          {i.label}
          {i.count !== null && <span className="font-mono text-text-2">{i.count}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A label over the sky, centred on its group or project; it moves with it (transform only). */
function Label({ label, size }: { label: SkyLabel; size: SkySize }) {
  const place = { transform: `translate(${label.x}px, ${label.y}px) translateX(-50%)` };
  if (size === "band")
    return (
      <div
        className={cn(
          "pointer-events-none absolute top-0 left-0 whitespace-nowrap text-body transition-transform duration-200",
          label.group ? LABEL_COLOR[label.group] : "text-text-3",
        )}
        style={place}
        data-label={label.key}
      >
        {label.text}
        {label.count !== null && <span className="ml-1.5 font-mono text-text-2">{label.count}</span>}
      </div>
    );
  return (
    <div
      className="pointer-events-none absolute top-0 left-0 text-center text-balance transition-transform duration-200"
      style={{ ...place, maxWidth: label.width }}
      data-label={label.key}
    >
      <div className="font-semibold text-sub text-text">{label.text}</div>
      {label.detail && <div className="mt-0.5 text-body text-text-2">{label.detail}</div>}
    </div>
  );
}
