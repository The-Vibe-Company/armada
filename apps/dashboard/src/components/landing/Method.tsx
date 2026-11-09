import type { CSSProperties, ReactNode } from "react";
import { MethodSteps } from "./MethodSteps";

// The method (THE-887, brought to Armada v2 by #564): the path of one piece of
// work, in five steps beside one window. Each scene draws its story from `--l`
// (0 to 1), which MethodSteps plays when its step is shown (THE-1049: never
// from the scroll). The story: a flaky checkout test, fixed by Codex.

export const STEPS = [
  {
    short: "Ask",
    title: "Ask for the work.",
    body: "Tell the agent that orchestrates your day what you need, in plain words. It reaches Armada through the remote MCP server.",
    window: "orchestrator · widgets",
  },
  {
    short: "Golden",
    title: "Build a golden.",
    body: "Your repositories, cloned over your own GitHub connection, set up once, scanned for GitHub tokens and saved as a snapshot on Boat or Modal.",
    window: "armada · golden widgets",
  },
  {
    short: "Launch",
    title: "Launch the agents.",
    body: "Each launch forks the golden into a sandbox of its own, with Claude Code or Codex, the model and effort you chose and only that agent's keys.",
    window: "armada · 4 sandboxes",
  },
  {
    short: "Watch",
    title: "Watch every move.",
    body: "Every prompt, message and command streams to the dashboard, the CLI and the orchestrator. Git and gh act as you, so the agent opens its own pull request.",
    window: "github · pull #52",
  },
  {
    short: "Follow up",
    title: "Follow up, then stop.",
    body: "Send the next prompt to the same sandbox, steer a running turn or interrupt it. Stop it when the work is done, or let its time run out.",
    window: "orchestrator · MCP tools",
  },
] as const;

/** An element that appears when its step's local progress passes `t` (0 to 1), over `span`. */
const at = (t: number, span = 0.14): CSSProperties => ({ ["--t" as string]: t, ["--span" as string]: span });

/** Sandboxes forked from the golden: their agent, their first prompt and their status. */
const TICKETS = [
  { id: "codex", title: "Fix the flaky checkout test", tag: "running", ready: true },
  { id: "claude", title: "Add a dark theme to the settings page", tag: "running", ready: true },
  { id: "codex", title: "Retry failed webhook deliveries", tag: "starting", ready: false },
  { id: "claude", title: "Review pull request #48", tag: "starting", ready: false },
];

const CHECKS = [
  { name: "Lint, typecheck and test", time: "2m 14s" },
  { name: "Build", time: "48s" },
  { name: "Commitizen title", time: "3s" },
];

/** The sandbox's statuses, then its turn's outcome, and where in the scene each starts. */
const PHASES = [
  { name: "starting", at: 0.16 },
  { name: "ready", at: 0.3 },
  { name: "running", at: 0.48 },
  { name: "finished", at: 0.88 },
];

const PIPE = ["Golden", "Sandbox", "Prompt", "Events", "Pull request", "Stop"];

function Scene({ index, children }: { index: number; children: ReactNode }) {
  return (
    <div className={`lp-scene is-${index}`} aria-hidden>
      {children}
    </div>
  );
}

export function Method() {
  return (
    <MethodSteps steps={STEPS}>
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
                The checkout test fails one run in ten. Which golden should I launch from?
              </p>
              <p className="lp-bubble is-you lp-k" style={at(0.22)}>
                widgets, on Boat.
              </p>
              <p className="lp-bubble is-agent lp-k" style={at(0.42)}>
                Claude Code or Codex? I recommend Codex for this one.
              </p>
              <p className="lp-bubble is-you lp-k" style={at(0.6)}>
                Codex, medium effort.
              </p>
              <p className="lp-bubble is-agent lp-k" style={at(0.78)}>
                Should it open a pull request when the test passes?
              </p>
              <p className="lp-bubble is-you lp-k" style={at(0.9, 0.08)}>
                Yes.
              </p>
            </div>
          </Scene>

          <Scene index={1}>
            <div className="lp-spec">
              <span className="lp-spec-title lp-k" style={at(0.02)}>
                widgets
              </span>
              <span className="lp-spec-meta lp-k" style={at(0.08)}>
                golden · boat · 2 repos
              </span>
              <span className="lp-spec-head lp-k" style={at(0.16)}>
                Repositories
              </span>
              <span className="lp-spec-text lp-k" style={at(0.2)}>
                acme/widgets and acme/widgets-api, on main, over your GitHub connection.
              </span>
              <span className="lp-spec-head lp-k" style={at(0.32)}>
                Build
              </span>
              {["Cloned both repositories", "Ran bun install", "Scanned for GitHub tokens: none"].map((d, k) => (
                <span key={d} className="lp-spec-decision lp-k" style={at(0.4 + k * 0.13)}>
                  <Check />
                  {d}
                </span>
              ))}
              <span className="lp-spec-head is-out lp-k" style={at(0.8)}>
                Kept out
              </span>
              <span className="lp-spec-text is-out lp-k" style={at(0.86)}>
                Your stored keys; a GitHub token the scan finds stops the snapshot
              </span>
            </div>
          </Scene>

          <Scene index={2}>
            <div className="lp-cut">
              <div className="lp-cut-spec lp-k" style={at(0)}>
                <span className="lp-cut-dot" />
                <span className="lp-mono lp-dim">golden</span>
                widgets
                <span className="lp-grow" />
                <span className="lp-dim">4 sandboxes</span>
              </div>
              <ul className="lp-tickets">
                {TICKETS.map((t, k) => (
                  <li key={t.title} className="lp-ticket lp-k is-split" style={at(0.12 + k * 0.16, 0.2)}>
                    <span className={`lp-ticket-ring ${t.ready ? "is-ready" : ""}`} />
                    <span className="lp-mono lp-dim">{t.id}</span>
                    <span className="lp-ticket-title">{t.title}</span>
                    <span className={`lp-tag ${t.ready ? "is-blue" : ""}`}>{t.tag}</span>
                  </li>
                ))}
              </ul>
              <p className="lp-cut-note lp-k" style={at(0.85)}>
                Each one a fork of the golden that stops by itself at its <span className="lp-mono">--ttl</span>.
              </p>
            </div>
          </Scene>

          <Scene index={3}>
            <div className="lp-ship-scene">
              <div className="lp-claim">
                <span className="lp-ticket-ring is-ready" />
                <span className="lp-mono lp-dim">codex</span>
                <span className="lp-ticket-title">Fix the flaky checkout test</span>
                <span className="lp-claim-phases">
                  {PHASES.map((ph, k) => (
                    <span
                      key={ph.name}
                      className={`lp-k ${ph.name === "finished" ? "is-lime" : ""}`}
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
                  <span className="lp-mono lp-dim">#52 · fix/checkout-clock</span>
                </div>
                <span className="lp-pr-title">fix(checkout): read the clock once per test</span>
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
                <span className="lp-dim">→</span> send: Also cover the refund page
              </span>
              <span className="lp-merge-line is-out lp-k" style={at(0.14)}>
                status running: a new turn, with the model and effort chosen at launch.
              </span>
              <span className="lp-merge-line is-out lp-k" style={at(0.3)}>
                wait: the turn finished.
              </span>
              <span className="lp-merge-line is-out lp-k" style={at(0.42)}>
                logs: refund page covered; pushed fix/checkout-clock, #52 updated.
              </span>
              <span className="lp-merge-line is-out lp-k" style={at(0.52)}>
                stop: the sandbox is stopping.
              </span>
              <div className="lp-merged lp-k" style={at(0.66, 0.18)}>
                <span className="lp-merged-badge">
                  <Check />
                </span>
                <span>
                  <strong>Done. #52 is yours to review.</strong>
                  <span className="lp-dim">The sandbox stopped; the golden stays for the next launch.</span>
                </span>
              </div>
            </div>
          </Scene>
        </div>
      </div>
    </MethodSteps>
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

/** A ship in flight: the mark's triangle, stretched into a dart (flock.ts). */
export function Dart({ color = "var(--frontier)", className }: { color?: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 16" width="24" height="16" aria-hidden className={className}>
      <path d="M23 8 L1 2 L1 14 Z" fill={color} />
    </svg>
  );
}
