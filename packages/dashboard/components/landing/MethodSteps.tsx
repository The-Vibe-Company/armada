"use client";

// The method's driver (THE-1049): the five steps as tabs beside one window.
// It never reads the scroll. Once the section is well on screen the steps
// play once, each scene's `--l` run by a CSS animation (landing.css), and the
// end of a scene moves on to the next step. A click, a focused step or an
// arrow key takes over and stops the auto-play. With reduced motion nothing
// plays: each scene shows its last frame and the steps change on demand.
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { prefersReducedMotion, whileVisible } from "./frames";

type Step = { short: string; title: string; body: string };

/** The step a key moves to from `current`, or null when the key is not one of the tablist's. */
export function stepForKey(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function MethodSteps({ steps, children }: { steps: readonly Step[]; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [step, setStep] = useState(0);
  const [auto, setAuto] = useState(true);
  const [motion, setMotion] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => setMotion(!prefersReducedMotion()), []);

  // Played only while well on screen (a band in the middle of the viewport) and the tab is visible.
  useEffect(() => {
    const el = ref.current;
    if (!el || !motion) return;
    return whileVisible(el, setPlaying, "-20% 0px -20% 0px");
  }, [motion]);

  const choose = (k: number) => {
    setAuto(false);
    setStep(k);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // The browser's own shortcuts (Alt+← for Back, Ctrl+Home…) stay the browser's.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = stepForKey(e.key, step, steps.length);
    if (next === null) return;
    e.preventDefault();
    choose(next);
    tabs.current[next]?.focus();
  };

  return (
    <section
      ref={ref}
      className="lp-method"
      id="method"
      aria-label="The method"
      data-step={step}
      data-motion={motion ? "" : undefined}
      data-playing={playing ? "" : undefined}
      onAnimationEnd={(e) => {
        if (e.animationName === "lp-scene-play" && auto && step < steps.length - 1) setStep(step + 1);
      }}
    >
      <div className="lp-method-inner">
        <div className="lp-method-words">
          <span className="lp-eyebrow is-lime">One method</span>
          <div className="lp-method-steps">
            {steps.map((s, k) => (
              <div
                key={s.short}
                id={`method-panel-${k}`}
                role="tabpanel"
                aria-labelledby={`method-tab-${k}`}
                className={`lp-method-step${k === step ? " is-active" : ""}`}
              >
                <h2 className="lp-method-title">{s.title}</h2>
                <p className="lp-method-body">{s.body}</p>
              </div>
            ))}
          </div>
          {/* Focus inside the steps is the visitor taking over: auto-play stops. */}
          <div
            className="lp-method-rail"
            role="tablist"
            aria-label="The method, step by step"
            onKeyDown={onKey}
            onFocus={() => setAuto(false)}
          >
            {steps.map((s, k) => (
              <button
                key={s.short}
                ref={(b) => {
                  tabs.current[k] = b;
                }}
                type="button"
                role="tab"
                id={`method-tab-${k}`}
                aria-selected={k === step}
                aria-controls={`method-panel-${k}`}
                tabIndex={k === step ? 0 : -1}
                className="lp-method-tab"
                data-state={k < step ? "done" : k === step ? "active" : "next"}
                style={{ ["--i" as string]: k }}
                onClick={() => choose(k)}
              >
                <span className="lp-method-seg" aria-hidden>
                  <span className="lp-method-fill" />
                </span>
                <span className="lp-mono">{String(k + 1).padStart(2, "0")}</span>
                {s.short}
              </button>
            ))}
          </div>
        </div>
        {children}
      </div>
    </section>
  );
}
