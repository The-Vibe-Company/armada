"use client";

// The fleet, live (THE-887, THE-931), restored by #564: the v1 dashboard's
// sidebar and overview (every session grouped by state) in a window, drawn as
// armada-v1-final drew them, from replica-script.ts. It plays the beats: the
// coordinator answers a question and the worker goes back to work, a hand-back
// arrives, then its merge waits for the owner and a pointer rests on its row,
// now "Waiting for your decision"; the clock runs fifteen times faster. It
// plays only while on screen; it is inert (nothing in it can be clicked or
// focused) and reads nothing from any server.
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { prefersReducedMotion, whileVisible } from "./frames";
import { MARK } from "./Mark";
import {
  type Beats,
  duration,
  GROUPS,
  HANDED_BACK,
  type Row,
  rowsAt,
  STEPS,
  type Stage,
  summary,
} from "./replica-script";

/** The replica's clock runs this many times faster than the viewer's. */
const SPEED = 15;
/** The beats, in seconds from the start of a loop. */
const BEATS = { deliver: 2.6, handBack: 5.6, validate: 8.6, point: 9.4, loop: 15.5 };

/** The coordinator's reading boxes (v1's `Steady`): the longest texts hold the width, so a tick moves nothing. */
const COORD_GHOSTS = ["coord. active", "coord. not seen", "coord. idle 59 min", "coord. idle 23 h 59"];

type Shown = { stage: Stage; now: number; beats: Beats };
const FIRST: Shown = { stage: "opening", now: 0, beats: { delivered: 0, handedBack: 0 } };

export function Replica() {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown>(FIRST);
  const [pointer, setPointer] = useState<{ x: number; y: number; on: boolean } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    let tick: ReturnType<typeof setInterval> | null = null;
    let loopStart = 0;
    let state = FIRST;

    const at = (seconds: number, run: () => void) => timers.push(setTimeout(run, seconds * 1000));
    /** Minutes on the replica's clock since the loop began. */
    const clock = () => ((performance.now() - loopStart) / 60_000) * SPEED;
    const show = (next: Shown) => {
      state = next;
      setShown(next);
    };

    /** Where the hand-back's reason is (else its row), in the replica's coordinates. */
    const target = () => {
      const row = el.querySelector<HTMLElement>(`[data-row="${HANDED_BACK}"]`);
      const badge = row?.querySelector<HTMLElement>(".ov-reason") ?? row;
      if (!badge) return null;
      const r = el.getBoundingClientRect();
      const b = badge.getBoundingClientRect();
      return { x: b.left - r.left + Math.min(b.width, 160) * 0.6, y: b.top - r.top + b.height * 0.6 };
    };

    const play = () => {
      loopStart = performance.now();
      show(FIRST);
      setPointer(null);
      tick = setInterval(() => show({ ...state, now: clock() }), 1000);
      at(BEATS.deliver, () =>
        show({ stage: "delivered", now: clock(), beats: { ...state.beats, delivered: clock() } }),
      );
      at(BEATS.handBack, () =>
        show({ stage: "handed-back", now: clock(), beats: { ...state.beats, handedBack: clock() } }),
      );
      at(BEATS.validate, () => show({ ...state, stage: "to-validate", now: clock() }));
      // The pointer comes in from below and to the right, and rests on the badge until the loop ends.
      at(BEATS.point, () => {
        const t = target();
        if (t) setPointer({ x: t.x + 140, y: t.y + 90, on: true });
      });
      at(BEATS.point + 0.1, () => {
        const t = target();
        if (t) setPointer({ x: t.x, y: t.y, on: true });
      });
      at(BEATS.loop, () => {
        stop();
        play();
      });
    };
    const stop = () => {
      for (const t of timers) clearTimeout(t);
      timers = [];
      if (tick) clearInterval(tick);
      tick = null;
    };
    const unwatch = whileVisible(el, (on) => (on ? play() : stop()), "-10% 0px");
    return () => {
      unwatch();
      stop();
    };
  }, []);

  const rows = rowsAt(shown.stage, shown.beats);
  const facts = summary(rows, shown.stage);

  return (
    <div className="lp-replica" ref={ref} data-stage={shown.stage}>
      <div className="lp-replica-window" inert>
        <aside className="sh-side" aria-label="Sidebar">
          <div className="sh-brand">
            <span className="sh-brand-home" title="Armada">
              <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden className="sh-logo">
                {MARK.map((s) => (
                  <path key={s.d} d={s.d} fill={s.fill} fillOpacity={s.opacity} />
                ))}
              </svg>
              <span className="sh-brand-name">Armada</span>
            </span>
            <span className="spacer" />
            <span className="lp-replica-org">Acme ▾</span>
          </div>
          <span className="sh-search">
            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden style={{ flex: "none" }}>
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="sh-search-text">Search a ticket…</span>
            <kbd className="sh-search-key">⌘K</kbd>
          </span>
          <nav className="sh-nav" aria-label="Sections">
            <span className="sh-item" aria-current="page">
              <span className="sh-item-label">Overview</span>
              <span className="sh-count">{facts.live}</span>
            </span>
            <span className="sh-item">
              <span className="sh-item-label">Validations</span>
              <span className="sh-count is-hot">{facts.validations}</span>
            </span>
            <span className="sh-item">
              <span className="sh-item-label">Activity</span>
            </span>
            <span className="sh-item">
              <span className="sh-item-label">Insights</span>
            </span>
          </nav>
          <nav className="sh-projects" aria-label="Projects">
            <div className="sh-heading">Projects</div>
            {facts.projects.map((p) => (
              <span className="sh-item" key={p.name}>
                <span
                  className="sh-diamond"
                  style={{ background: p.idleSince === null ? "var(--green)" : "var(--amber)" }}
                />
                <span className="sh-item-label">{p.name}</span>
                {p.blocked > 0 && <span className="sh-count is-blocked">{p.blocked}</span>}
                <span className="sh-count">{p.live}</span>
              </span>
            ))}
          </nav>
          <span className="spacer" />
          <span className="sh-item">
            <span className="sh-item-label">Organization</span>
          </span>
          <div className="sh-live">
            <span className="sh-live-dot" aria-hidden />
            <span className="tnum">Live · read 0 s ago</span>
          </div>
        </aside>
        <div className="sh-main lp-replica-main">
          <header className="ui-header">
            <span className="sh-crumb">
              <span aria-current="page">Overview</span>
            </span>
            <span className="spacer" />
            <span className="ui-header-actions">
              <span className="ov-views">
                <span className="ov-view" aria-current="true">
                  List
                </span>
                <span className="ov-view">List + preview</span>
              </span>
            </span>
          </header>
          <div className="lp-replica-scroll">
            <div className="ov">
              <div className="ov-head">
                <p className="ov-headline">{facts.headline}</p>
                <p className="ov-subline">{facts.subline}</p>
              </div>
              <ul className="ov-projects">
                {facts.projects.map((p) => {
                  const coord =
                    p.idleSince === null ? "coord. active" : `coord. idle ${duration(shown.now - p.idleSince)}`;
                  return (
                    <li key={p.name}>
                      <span className="ov-project">
                        <span className="ov-project-head">
                          <span className="ov-project-name">{p.name}</span>
                          <span className="spacer" />
                          <span className="ov-project-n">
                            {p.done} / {p.total}
                          </span>
                        </span>
                        <span className="ov-project-bar" aria-hidden>
                          <span style={{ width: `${Math.round((p.done / p.total) * 100)}%` }} />
                        </span>
                        <span className="ov-project-facts">
                          <span style={{ color: p.blocked ? "var(--red)" : "var(--text-3)" }}>{p.blocked} blocked</span>
                          <span style={{ color: p.you ? "var(--amber)" : "var(--text-3)" }}>{p.you} for you</span>
                          <span>{p.running} in flight</span>
                          <span
                            className="ov-project-coord"
                            style={{ color: p.idleSince === null ? "var(--green)" : "var(--amber)" }}
                          >
                            <span className="ov-diamond" aria-hidden />
                            <span className="ui-steady">
                              {COORD_GHOSTS.map((g) => (
                                <span key={g} className="ui-steady-ghost" aria-hidden>
                                  {g}
                                </span>
                              ))}
                              <span className="ui-steady-now">{coord}</span>
                            </span>
                          </span>
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="ov-bar">
                <span className="ov-chips">
                  <span className="ov-chip" aria-current="true">
                    All<span className="ov-chip-n">{facts.all}</span>
                  </span>
                  {facts.projects.map((p) => (
                    <span className="ov-chip" key={p.name}>
                      {p.name}
                      <span className="ov-chip-n">{p.all}</span>
                    </span>
                  ))}
                </span>
                <span className="spacer" />
                <span className="ov-groupby">Group by</span>
                <span className="ov-chips">
                  <span className="ov-chip" aria-current="true">
                    State
                  </span>
                  <span className="ov-chip">Project</span>
                </span>
              </div>
              <div className="ov-list">
                {GROUPS.map((g) => {
                  const members = rows.filter((r) => r.group === g.group);
                  if (!members.length) return null;
                  return (
                    <section className="ov-group" key={g.group}>
                      <h2 className="ov-group-h">
                        <span className="ov-dot" aria-hidden style={{ background: g.color }} />
                        <span className="ov-group-name">{g.name}</span>
                        <span className="ov-group-n">{members.length}</span>
                        {g.hint && <span className="ov-group-hint">{g.hint}</span>}
                      </h2>
                      {members.map((r) => (
                        <OverviewRow key={r.id} row={r} color={g.color} now={shown.now} />
                      ))}
                    </section>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
      {pointer && (
        <span
          className="lp-pointer"
          data-on={pointer.on || undefined}
          style={{ transform: `translate(${pointer.x}px, ${pointer.y}px)` }}
          aria-hidden
        >
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
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

/** One session: its state's dot, its ticket, what it is and why it is there, its project, steps and last report. */
function OverviewRow({ row, color, now }: { row: Row; color: string; now: number }) {
  const ago = duration(now - row.at);
  const merged = row.group === "merged";
  const reasonColor = row.group === "running" || merged ? "var(--text-2)" : color;
  const stepColor = (k: number): CSSProperties["background"] =>
    merged || k < row.step ? "var(--step-done)" : k === row.step ? color : "var(--step-next)";
  return (
    <div className="ov-row" data-row={row.id}>
      <span className="ov-dot" aria-hidden style={{ background: color }} />
      <span className="ov-id">{row.id}</span>
      <span className="ov-main">
        <span className="ov-title">{row.title}</span>
        <span className="ov-reason" style={{ color: reasonColor }}>
          {row.reason.replace("{silent}", ago)}
        </span>
      </span>
      <span className="ov-proj">{row.project}</span>
      <span className="ov-steps">
        {STEPS.map((s, k) => (
          <span key={s} style={{ background: stepColor(k) }} />
        ))}
      </span>
      <span className="ov-last">
        <span className="tnum">{ago}</span>
      </span>
    </div>
  );
}
