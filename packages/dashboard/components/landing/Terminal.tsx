"use client";

// The landing's terminal (THE-887): a coordinator's session replayed from
// transcript.ts, which Armada's own code wrote (scripts/landing.ts). It types
// each command, prints what Armada printed line by line, and starts over. It
// plays only while on screen; with reduced motion it shows the whole session at once.
import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion, whileVisible } from "./frames";
import type { TerminalCommand } from "./terminal-types";

/** A line's tone, from what Armada's plain text says: no color is in the output itself. */
function tone(line: string): string | undefined {
  if (/^\s*! /.test(line)) return "is-red";
  if (/^\* /.test(line)) return "is-lime";
  if (/^\s*silent ·/.test(line) || /no report for/.test(line)) return "is-amber";
  if (/^\s*#\d+ question/.test(line)) return "is-orange";
  if (/^(In flight|Ready to start|Unblocked|Pull requests waiting|Inbox of)/.test(line)) return "is-head";
  if (/keep watching: armada watch$/.test(line)) return "is-blue";
  return undefined;
}

type Shown = { command: number; typed: number; lines: number };

export function Terminal({ commands, title }: { commands: TerminalCommand[]; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const all: Shown = { command: commands.length - 1, typed: Number.POSITIVE_INFINITY, lines: Number.POSITIVE_INFINITY };
  const [shown, setShown] = useState<Shown>(all);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let state: Shown = { command: 0, typed: 0, lines: 0 };
    const set = (next: Shown) => {
      state = next;
      setShown(next);
    };
    const later = (ms: number, run: () => void) => {
      timer = setTimeout(run, ms);
    };
    const step = () => {
      const c = commands[state.command];
      if (!c) return;
      const lines = c.output.split("\n").length;
      if (state.typed < c.command.length) {
        set({ ...state, typed: state.typed + 1 });
        return later(state.typed === 0 ? 500 : 38 + ((state.typed * 7) % 5) * 9, step);
      }
      if (state.lines < lines) {
        // `armada watch` waits before it prints: it returns when something needs the coordinator.
        const wait = state.lines === 0 ? (c.command === "armada watch" ? 1500 : 350) : 34;
        return later(wait, () => {
          set({ ...state, lines: state.lines + 1 });
          step();
        });
      }
      const next = state.command < commands.length - 1 ? state.command + 1 : 0;
      later(next ? 1400 : 4200, () => {
        set({ command: next, typed: 0, lines: 0 });
        step();
      });
    };
    const unwatch = whileVisible(el, (on) => {
      if (on) {
        setPlaying(true);
        set({ command: 0, typed: 0, lines: 0 });
        step();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    });
    return () => {
      unwatch();
      if (timer) clearTimeout(timer);
    };
  }, [commands]);

  // Follow the output as it grows: the newest line stays in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new line is the signal to scroll
  useEffect(() => {
    const b = body.current;
    if (b) b.scrollTop = b.scrollHeight;
  }, [shown]);

  return (
    <div className="lp-terminal" ref={ref}>
      <div className="lp-terminal-bar">
        <span className="lp-terminal-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="lp-terminal-title">{title}</span>
      </div>
      {/* The replay is decorative; the whole session is in the text a screen reader gets. */}
      <div className="lp-terminal-body" ref={body} aria-hidden={playing || undefined}>
        {commands.map((c, k) => {
          if (k > shown.command) return null;
          const current = k === shown.command;
          const typed = current ? c.command.slice(0, shown.typed) : c.command;
          const lines = c.output.split("\n");
          const visible = current ? lines.slice(0, shown.lines) : lines;
          const typing = current && shown.typed < c.command.length;
          const waiting = current && !typing && shown.lines === 0;
          return (
            <div key={c.command} className="lp-terminal-run">
              <div className="lp-terminal-command">
                <span className="lp-terminal-prompt">❯</span> {typed}
                {(typing || waiting) && <span className="lp-caret" />}
              </div>
              {visible.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the output's lines are fixed and in order
                <div key={i} className={`lp-terminal-line ${tone(line) ?? ""}`}>
                  {line || " "}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {playing && <pre className="sr-only">{commands.map((c) => `$ ${c.command}\n${c.output}`).join("\n\n")}</pre>}
    </div>
  );
}
