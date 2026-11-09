import Link from "next/link";
import type { ReactNode } from "react";
import { CopyCommand } from "./Copy";
import { CIPHER, GITHUB_TOKEN_HOURS, STORY } from "./content";
import { ControlFigure, FleetFigure, GoldenFigure, KeysFigure, ResumeFigure, ToolsFigure } from "./Figures";
import { Line } from "./Line";
import { Review } from "./Review";

// The story below the hero, read as one split diff (split-diff direction): a
// coding task today on the left, the same task with Armada on the right. Each
// chapter is a hunk whose header is its heading; between hunks, a folded line
// says what does not change. On a phone the diff is unified: the old line
// above the new ones. The anchors are the nav's and the README's (#method,
// #fleet, #cli, #keys, #install): they move with their chapter, never away.

type Hunk = {
  id: string;
  /** The chapter's name: the nav's word where the nav has one. */
  label: string;
  title: string;
  /** The task today: plain, only what Armada's facts imply. */
  before: string;
  /** The task with Armada, one benefit a line. `[word]` marks a changed word, `` `code` `` a flag. */
  after: string[];
  figure: ReactNode;
  command: string;
};

const HUNKS: Hunk[] = [
  {
    id: "method",
    label: "Method",
    title: "Set up your repos once.",
    before: "Each fresh start: [clone], install, run the setup again.",
    after: [
      "A [golden]: your repositories, cloned as you, set up by your script.",
      "Saved as a snapshot on [Boat or Modal]. Private, or shared with your org.",
      "Scanned for GitHub tokens, working tree and history, before it saves.",
    ],
    figure: <GoldenFigure />,
    command: STORY.golden,
  },
  {
    id: "fleet",
    label: "Fleet",
    title: "Launch one agent, or ten.",
    before: "[One checkout] on one laptop, shared by whatever runs in it.",
    after: [
      "Each launch forks the golden into [its own sandbox]: own machine, own files.",
      "Four fixes at once, and none touches another's checkout.",
      "[Claude Code or Codex], with the model and reasoning effort you name, kept for later turns.",
    ],
    figure: <FleetFigure />,
    command: STORY.launch,
  },
  {
    id: "tools",
    label: "Tools",
    title: "Hand them your tools.",
    before: "MCP servers [set up on your machine], for the agent on it.",
    after: [
      "Register an MCP server [once], for you or your org.",
      "HTTP, SSE or stdio; OAuth, a bearer token or headers.",
      "Pick a launch's connections, or pass `--connections`. Prepared before every turn.",
      "Secrets stored encrypted, never shown again.",
    ],
    figure: <ToolsFigure />,
    command: STORY.tools,
  },
  {
    id: "resume",
    label: "Resume",
    title: "Stop the machine. Keep the thread.",
    before: "Close the lid and [the agent stops with it].",
    after: [
      "[Stop] removes the machine and keeps the disk and the conversation.",
      "The [next send] resumes where it left off, connections prepared again.",
      "Stops by itself after four hours, or the time you set with `--ttl`.",
    ],
    figure: <ResumeFigure />,
    command: STORY.resume,
  },
  {
    id: "cli",
    label: "CLI",
    title: "Drive it from the browser, the terminal or your agent.",
    before: "The session lives in [the terminal that started it].",
    after: [
      "Follow [every event] live. Send, steer, interrupt, exec, wait, stop.",
      "The dashboard, the `armada` CLI and Armada's MCP server: [one API], the same rules.",
      "Armada launches; your agent decides what to launch.",
    ],
    figure: <ControlFigure />,
    command: STORY.watch,
  },
  {
    id: "keys",
    label: "Keys",
    title: "Your keys stay in Armada.",
    before: "Agent keys [in files on the machine] the agent runs on.",
    after: [
      `Each agent's key stored once, for you or your org, sealed with [${CIPHER}].`,
      "In through stdin or a file, never an argument. Never shown again.",
      `A sandbox gets [only its agent's key]; git and gh act as you, with a token valid for ${GITHUB_TOKEN_HOURS} hours.`,
      "A golden gets no key: a GitHub token found in one stops its snapshot.",
    ],
    figure: <KeysFigure />,
    command: STORY.keys,
  },
];

/** The chapters the nav names, in order, and where the install step is. */
const INDEX = [
  ["method", "Method"],
  ["fleet", "Fleet"],
  ["cli", "CLI"],
  ["keys", "Keys"],
  ["install", "Install"],
] as const;

/** What stays the same between two hunks: the folded, unchanged lines. */
const UNCHANGED = [
  "Your repositories stay on GitHub.",
  "The agent itself: Claude Code or Codex.",
  "Your prompt, in your words.",
  "Pull requests open on GitHub; the merge stays yours.",
  "Git and gh, acting as you.",
];

/** A line's words: `[changed]` and `` `code` `` become marks. */
function words(text: string): ReactNode[] {
  return text
    .split(/(\[[^\]]+\]|`[^`]+`)/)
    .filter(Boolean)
    .map((part) => {
      // A line's parts never repeat: each is its own key.
      if (part.startsWith("["))
        return (
          <mark key={part} className="dx-w">
            {part.slice(1, -1)}
          </mark>
        );
      if (part.startsWith("`")) return <code key={part}>{part.slice(1, -1)}</code>;
      return <span key={part}>{part}</span>;
    });
}

function HunkView({ hunk, old, now }: { hunk: Hunk; old: number; now: number }) {
  const added = hunk.after.length + 1;
  return (
    <section id={hunk.id} className="dx-hunk" aria-labelledby={`${hunk.id}-title`}>
      <h2 id={`${hunk.id}-title`} className="dx-hh">
        <span className="dx-range">
          <span className="dx-label">{hunk.label}</span>
          <span aria-hidden>
            @@ -{old},1 +{now},{added} @@
          </span>
        </span>
        <span className="dx-title">{hunk.title}</span>
      </h2>
      <div className="dx-rows">
        <div className="dx-side is-old">
          <Line kind="del" no={old}>
            <p className="dx-before">
              <span className="sr-only">Today: </span>
              {words(hunk.before)}
            </p>
          </Line>
          <div className="dx-fill" aria-hidden />
        </div>
        <div className="dx-side is-new">
          {hunk.after.map((line, k) => (
            <Line key={line} kind="add" no={now + k}>
              <p>
                {k === 0 && <span className="sr-only">With Armada: </span>}
                {words(line)}
              </p>
            </Line>
          ))}
        </div>
      </div>
      <Line kind="add" no={now + hunk.after.length} block>
        <div className="dx-proof">
          <div className="dx-proof-figure">{hunk.figure}</div>
          <div className="dx-proof-cmd">
            <CopyCommand command={hunk.command} words />
          </div>
        </div>
      </Line>
    </section>
  );
}

function Fold({ children }: { children: string }) {
  return (
    <div className="dx-fold">
      <span className="dx-fold-icon" aria-hidden>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <path
            d="M5 6l3-3 3 3M5 10l3 3 3-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <p>
        <span className="dx-fold-tag">unchanged</span> {children}
      </p>
    </div>
  );
}

export function Story() {
  // The gutters count on: each hunk's one old line and its new ones, each fold one line on both sides.
  let old = 1;
  let now = 1;
  const placed = HUNKS.map((hunk) => {
    const at = { hunk, old, now };
    old += 2;
    now += hunk.after.length + 2;
    return at;
  });
  return (
    <div className="dx">
      <nav className="dx-index" aria-label="The story">
        <ul>
          {INDEX.map(([id, name]) => (
            <li key={id}>
              <a href={`#${id}`}>{name}</a>
            </li>
          ))}
        </ul>
        <Link href="/login" className="lp-button is-sm dx-approve">
          Sign in to try Armada
        </Link>
      </nav>
      <div className="dx-file">
        <div className="dx-head">
          <p className="dx-head-side is-old">
            <span className="dx-head-mk" aria-hidden>
              −
            </span>
            Today: one laptop, one checkout
          </p>
          <p className="dx-head-side is-new">
            <span className="dx-head-mk" aria-hidden>
              +
            </span>
            With Armada: a sandbox for every task
          </p>
        </div>
        {placed.map(({ hunk, old, now }, k) => (
          <div key={hunk.id} className="dx-step">
            <HunkView hunk={hunk} old={old} now={now} />
            {UNCHANGED[k] && <Fold>{UNCHANGED[k]}</Fold>}
          </div>
        ))}
        <Review />
      </div>
    </div>
  );
}
