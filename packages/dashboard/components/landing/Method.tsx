import type { CSSProperties, ReactNode } from "react";
import { Scrub } from "./Scrub";

// The method (THE-887): the path of one ticket, played by the scroll. A
// sticky stage holds the step's words on the left and one window on the
// right whose scene is drawn from `--p` (Scrub.tsx), so scrolling back plays
// it backwards. With reduced motion every step stands still, one after the
// other. The story is the README's own example: magic-link sign-in.

export const STEPS = [
  {
    short: "Grill",
    title: "Grill the decisions.",
    body: "Every open question is asked and answered before a line of code is written.",
    window: "grill · magic link sign-in",
  },
  {
    short: "Spec",
    title: "Write the spec.",
    body: "The answers become one spec: the goal, the decisions, what stays out.",
    window: "linear · WID-1 · spec",
  },
  {
    short: "Tickets",
    title: "Cut it into tickets.",
    body: "Linear holds them, each small enough for one agent, with what blocks what. Armada ranks the ready ones by what they unlock.",
    window: "linear · WID-1 · 4 tickets",
  },
  {
    short: "Green PR",
    title: "Ship each one green.",
    body: "One worker claims each ticket, reports every phase and hands back its pull request only when every required check is green on its head.",
    window: "github · pull #41",
  },
  {
    short: "Merge",
    title: "The coordinator merges.",
    body: "It checks the hand-back, the head and the checks, squash-merges pinned to that commit and moves the ticket to Done. Workers never merge.",
    window: "coordinator · widgets",
  },
] as const;

/** An element that appears when its step's local progress passes `t` (0 to 1), over `span`. */
const at = (t: number, span = 0.14): CSSProperties => ({ ["--t" as string]: t, ["--span" as string]: span });

const TICKETS = [
  { id: "WID-12", title: "Issue and email a sign-in link", tag: "ready-for-agent", ready: true },
  { id: "WID-13", title: "Store sessions in SQLite", tag: "ready-for-agent", ready: true },
  { id: "WID-14", title: "Expire links after 15 minutes", tag: "blocked by WID-12", ready: false },
  { id: "WID-15", title: "Refuse a link used twice", tag: "blocked by WID-12", ready: false },
];

const CHECKS = [
  { name: "Lint, typecheck and test", time: "2m 14s" },
  { name: "Build", time: "48s" },
  { name: "Commitizen title", time: "3s" },
];

/** The worker's phases on its ticket, as `armada report` sets them, and where in the scene each starts. */
const PHASES = [
  { name: "planning", at: 0.16 },
  { name: "implementing", at: 0.3 },
  { name: "shipping", at: 0.48 },
  { name: "ready-to-merge", at: 0.88 },
];

const PIPE = ["Plan", "Approval", "Implementing", "PR", "CI", "Merge"];

function Scene({ index, children }: { index: number; children: ReactNode }) {
  return (
    <div className={`lp-scene is-${index}`} style={{ ["--a" as string]: index / STEPS.length }} aria-hidden>
      {children}
    </div>
  );
}

export function Method() {
  return (
    <Scrub steps={STEPS.length} className="lp-method" id="method" label="The method">
      <div className="lp-method-stage">
        <div className="lp-method-inner">
          <div className="lp-method-words">
            <span className="lp-eyebrow is-lime">One method</span>
            <ol className="lp-method-steps">
              {STEPS.map((s, k) => (
                <li key={s.short} className="lp-method-step" data-index={k}>
                  <h2 className="lp-method-title">{s.title}</h2>
                  <p className="lp-method-body">{s.body}</p>
                </li>
              ))}
            </ol>
            <div className="lp-method-rail" aria-hidden>
              <span className="lp-method-track">
                <span className="lp-method-fill" />
              </span>
              <span className="lp-method-labels">
                {STEPS.map((s, k) => (
                  <span key={s.short} data-index={k}>
                    <span className="lp-mono">{String(k + 1).padStart(2, "0")}</span>
                    {s.short}
                  </span>
                ))}
              </span>
            </div>
          </div>

          <div className="lp-window lp-method-window">
            <div className="lp-window-bar">
              <span className="lp-window-dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
              <span className="lp-window-titles">
                {STEPS.map((s, k) => (
                  <span key={s.short} data-index={k}>
                    {s.window}
                  </span>
                ))}
              </span>
            </div>
            <div className="lp-window-body">
              <Scene index={0}>
                <div className="lp-chat">
                  <p className="lp-bubble is-agent lp-k" style={at(0.05)}>
                    Which store keeps the sessions? I recommend SQLite.
                  </p>
                  <p className="lp-bubble is-you lp-k" style={at(0.22)}>
                    SQLite, for the first slice.
                  </p>
                  <p className="lp-bubble is-agent lp-k" style={at(0.42)}>
                    How long should a sign-in link stay valid?
                  </p>
                  <p className="lp-bubble is-you lp-k" style={at(0.6)}>
                    15 minutes.
                  </p>
                  <p className="lp-bubble is-agent lp-k" style={at(0.78)}>
                    Can a link be used twice? I recommend no.
                  </p>
                  <p className="lp-bubble is-you lp-k" style={at(0.9, 0.08)}>
                    No.
                  </p>
                </div>
              </Scene>

              <Scene index={1}>
                <div className="lp-spec">
                  <span className="lp-spec-title lp-k" style={at(0.02)}>
                    Magic link sign-in
                  </span>
                  <span className="lp-spec-meta lp-k" style={at(0.08)}>
                    spec · WID-1 · 3 decisions
                  </span>
                  <span className="lp-spec-head lp-k" style={at(0.16)}>
                    Goal
                  </span>
                  <span className="lp-spec-text lp-k" style={at(0.2)}>
                    People sign in with a link sent by email. No password.
                  </span>
                  <span className="lp-spec-head lp-k" style={at(0.32)}>
                    Decisions
                  </span>
                  {[
                    "Sessions are stored in SQLite",
                    "A link expires after 15 minutes",
                    "A used link cannot be used again",
                  ].map((d, k) => (
                    <span key={d} className="lp-spec-decision lp-k" style={at(0.4 + k * 0.13)}>
                      <Check />
                      {d}
                    </span>
                  ))}
                  <span className="lp-spec-head is-out lp-k" style={at(0.8)}>
                    Out of scope
                  </span>
                  <span className="lp-spec-text is-out lp-k" style={at(0.86)}>
                    Single sign-on, passkeys
                  </span>
                </div>
              </Scene>

              <Scene index={2}>
                <div className="lp-cut">
                  <div className="lp-cut-spec lp-k" style={at(0)}>
                    <span className="lp-cut-dot" />
                    <span className="lp-mono lp-dim">WID-1</span>
                    Magic link sign-in
                    <span className="lp-grow" />
                    <span className="lp-dim">4 sub-issues</span>
                  </div>
                  <ul className="lp-tickets">
                    {TICKETS.map((t, k) => (
                      <li key={t.id} className="lp-ticket lp-k is-split" style={at(0.12 + k * 0.16, 0.2)}>
                        <span className={`lp-ticket-ring ${t.ready ? "is-ready" : ""}`} />
                        <span className="lp-mono lp-dim">{t.id}</span>
                        <span className="lp-ticket-title">{t.title}</span>
                        <span className={`lp-tag ${t.ready ? "is-blue" : ""}`}>{t.tag}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="lp-cut-note lp-k" style={at(0.85)}>
                    Ready to start, ranked by what they unlock: <span className="lp-mono">WID-12</span> unblocks two.
                  </p>
                </div>
              </Scene>

              <Scene index={3}>
                <div className="lp-ship-scene">
                  <div className="lp-claim">
                    <span className="lp-ticket-ring is-ready" />
                    <span className="lp-mono lp-dim">WID-12</span>
                    <span className="lp-ticket-title">Issue and email a sign-in link</span>
                    <span className="lp-claim-phases">
                      {PHASES.map((ph, k) => (
                        <span
                          key={ph.name}
                          className={`lp-k ${ph.name === "ready-to-merge" ? "is-lime" : ""}`}
                          style={{ ...at(ph.at, 0.05), ["--tn" as string]: PHASES[k + 1]?.at ?? 2 }}
                        >
                          {ph.name}
                        </span>
                      ))}
                    </span>
                  </div>
                  <span className="lp-worker-ship" aria-hidden>
                    <Dart />
                    <Dart color="var(--done)" className="is-green" />
                  </span>
                  <div className="lp-pr lp-k" style={at(0.45)}>
                    <div className="lp-pr-head">
                      <span className="lp-pill-open">Open</span>
                      <span className="lp-mono lp-dim">#41 · feature/wid-12-issue-a-sign-in-link</span>
                    </div>
                    <span className="lp-pr-title">feat(auth): issue and email a sign-in link</span>
                    <ul className="lp-checks">
                      {CHECKS.map((c, k) => (
                        <li key={c.name} className="lp-check" style={at(0.56 + k * 0.1, 0.06)}>
                          <span className="lp-light">
                            <Check />
                          </span>
                          {c.name}
                          <span className="lp-grow" />
                          <span className="lp-mono lp-dim">{c.time}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="lp-pipe">
                    {PIPE.map((label, k) => (
                      <span key={label} className="lp-pipe-step" style={at(k * 0.17, 0.08)}>
                        <i />
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              </Scene>

              <Scene index={4}>
                <div className="lp-merge">
                  <span className="lp-merge-line lp-k" style={at(0.02)}>
                    <span className="lp-dim">$</span> armada merge 41
                  </span>
                  <span className="lp-merge-line is-out lp-k" style={at(0.14)}>
                    Checklist passed for #41 (WID-12): handed back at a3f9c2e, CLEAN, checks green, no open review
                    thread.
                  </span>
                  <span className="lp-merge-line is-out lp-k" style={at(0.3)}>
                    Merged #41 into main as 9e1b7c4 (head a3f9c2e).
                  </span>
                  <span className="lp-merge-line is-out lp-k" style={at(0.42)}>
                    WID-12: moved to Done, agent and ready labels removed, merged status posted.
                  </span>
                  <span className="lp-merge-line is-out lp-k" style={at(0.52)}>
                    Hand-back resolved in the coordinator's inbox.
                  </span>
                  <div className="lp-merged lp-k" style={at(0.66, 0.18)}>
                    <span className="lp-merged-badge">
                      <Check />
                    </span>
                    <span>
                      <strong>Merged. WID-12 is Done.</strong>
                      <span className="lp-dim">By the Widgets coordinator. Next up: WID-14 and WID-15.</span>
                    </span>
                  </div>
                </div>
              </Scene>
            </div>
          </div>
        </div>
      </div>
    </Scrub>
  );
}

export function Check() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden className="lp-check-icon">
      <path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A ship in flight: the mark's triangle, stretched into a dart (sky.ts). */
export function Dart({ color = "var(--frontier)", className }: { color?: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 16" width="24" height="16" aria-hidden className={className}>
      <path d="M23 8 L1 2 L1 14 Z" fill={color} />
    </svg>
  );
}
