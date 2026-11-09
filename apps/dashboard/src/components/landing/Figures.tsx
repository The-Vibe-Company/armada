import type { ReactNode } from "react";
import { CIPHER, GITHUB_TOKEN_HOURS } from "./content";

// The diagrams of the diff (split-diff direction): each one sits inside an added
// line on the right, drawn as a commit graph: a rail, its nodes, the branches a
// launch forks and the doors that merge into one API. HTML and CSS only, so the
// words keep their size on a phone.

type Dot = "lime" | "paper" | "sky" | "red" | "hollow" | "ship" | "ship-lime";

function Node({
  dot = "paper",
  branch,
  cut = false,
  children,
}: {
  dot?: Dot;
  /** Out of the rail (a fork) or into it (a merge). */
  branch?: "out" | "in";
  cut?: boolean;
  children: ReactNode;
}) {
  const cls = ["dg-n", branch === "out" ? "is-out" : "", branch === "in" ? "is-in" : "", cut ? "is-cut" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <li className={cls}>
      <i className={`dg-dot is-${dot}`} />
      {children}
    </li>
  );
}

/** A step along the rail with no node: the command that moves from one state to the next. */
function Edge({ children }: { children: ReactNode }) {
  return (
    <li className="dg-n is-edge">
      <span className="dg-edge">{children}</span>
    </li>
  );
}

const Name = ({ children }: { children: ReactNode }) => <b className="dg-name">{children}</b>;
const Tag = ({ tone = "", children }: { tone?: string; children: ReactNode }) => (
  <span className={`dg-tag ${tone}`}>{children}</span>
);

function Figure({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <figure className="dg" role="img" aria-label={label}>
      <figcaption className="dg-cap">{title}</figcaption>
      <ol className="dg-rail">{children}</ol>
    </figure>
  );
}

export function GoldenFigure() {
  return (
    <Figure
      title="golden widgets"
      label="Three repositories merge into one golden: cloned as you, set up by your script, scanned for GitHub tokens, then saved as a snapshot on Boat or Modal, private or shared with the org."
    >
      <Node branch="in">
        <Name>acme/widgets</Name> <Tag>main</Tag>
      </Node>
      <Node branch="in">
        <Name>acme/api</Name> <Tag>main</Tag>
      </Node>
      <Node branch="in">
        <Name>acme/ui</Name> <Tag>release</Tag>
      </Node>
      <Node>cloned as you</Node>
      <Node>set up by your script</Node>
      <Node dot="sky">scanned for GitHub tokens</Node>
      <Node dot="lime">
        <Name>snapshot</Name> <Tag>Boat or Modal</Tag> <Tag>private or org</Tag>
      </Node>
    </Figure>
  );
}

const SANDBOXES = [
  { agent: "Claude Code", model: "claude-opus-5-5", effort: "high", status: "running" },
  { agent: "Codex", model: "gpt-6.1-sol", effort: "medium", status: "running" },
  { agent: "Claude Code", model: "claude-opus-5-5", effort: "low", status: "ready" },
  { agent: "Codex", model: "gpt-6.1-sol", effort: "high", status: "running" },
];

export function FleetFigure() {
  return (
    <Figure
      title="armada launch widgets"
      label="One golden forks into four sandboxes, each with its own agent, model and reasoning effort: two Claude Code, two Codex."
    >
      <Node dot="lime">
        <Name>widgets</Name> <Tag>golden</Tag>
      </Node>
      {SANDBOXES.map((s, k) => (
        <Node key={`${s.agent}-${s.effort}`} branch="out" dot={k === 0 ? "ship-lime" : "ship"}>
          <Name>{s.agent}</Name> <Tag>{s.model}</Tag> <Tag>{s.effort}</Tag>{" "}
          <Tag tone={s.status === "running" ? "is-live" : "is-ready"}>{s.status}</Tag>
        </Node>
      ))}
    </Figure>
  );
}

export function ToolsFigure() {
  return (
    <Figure
      title="--connections"
      label="A sandbox wired to three MCP connections: docs over HTTP with OAuth, a tracker over SSE with a bearer token, and a local database over stdio, prepared before every turn."
    >
      <Node dot="lime">
        <Name>sandbox</Name> <Tag>Codex</Tag>
      </Node>
      <Edge>prepared before every turn</Edge>
      <Node branch="out" dot="sky">
        <Name>docs</Name> <Tag>HTTP</Tag> <Tag>OAuth</Tag>
      </Node>
      <Node branch="out" dot="sky">
        <Name>tracker</Name> <Tag>SSE</Tag> <Tag>bearer</Tag>
      </Node>
      <Node branch="out" dot="sky">
        <Name>local-db</Name> <Tag>stdio</Tag>
      </Node>
    </Figure>
  );
}

export function ResumeFigure() {
  return (
    <Figure
      title="one sandbox, one thread"
      label="Stopping a sandbox removes its machine and keeps its disk and conversation; the next prompt brings a machine back with both."
    >
      <Node dot="lime">
        <Name>running</Name> <Tag>machine</Tag> <Tag>disk</Tag> <Tag>conversation</Tag>
      </Node>
      <Edge>armada stop</Edge>
      <Node dot="hollow">
        <Name>stopped</Name> <Tag>no machine, no cost</Tag> <Tag>disk</Tag> <Tag>conversation</Tag>
      </Node>
      <Edge>armada send</Edge>
      <Node dot="lime">
        <Name>running again</Name> <Tag>same disk</Tag> <Tag>same thread</Tag>
      </Node>
    </Figure>
  );
}

export function ControlFigure() {
  return (
    <Figure
      title="one API"
      label="The dashboard, the armada CLI and your agent over MCP all go through one Armada API with one set of rules, to the same sandboxes."
    >
      <Node branch="in" dot="sky">
        <Name>dashboard</Name> <Tag>on the web</Tag>
      </Node>
      <Node branch="in" dot="sky">
        <Name>armada</Name> <Tag>in a terminal</Tag>
      </Node>
      <Node branch="in" dot="sky">
        <Name>your agent</Name> <Tag>over MCP</Tag>
      </Node>
      <Node dot="lime">
        <Name>Armada API</Name> <Tag>the same rules for every door</Tag>
      </Node>
      <Node>
        <Name>sandboxes</Name> <Tag>send</Tag> <Tag>steer</Tag> <Tag>interrupt</Tag> <Tag>wait</Tag> <Tag>stop</Tag>
      </Node>
    </Figure>
  );
}

export function KeysFigure() {
  return (
    <Figure
      title="vault"
      label={`The vault seals each key with ${CIPHER}. Of the stored keys, a sandbox receives only its agent's, plus a GitHub token valid for ${GITHUB_TOKEN_HOURS} hours; a golden receives no key.`}
    >
      <Node dot="lime">
        <Name>Armada</Name> <Tag>{CIPHER}</Tag>
      </Node>
      <Node branch="out" dot="paper">
        <Name>sandbox</Name> <Tag>its agent's key</Tag>
      </Node>
      <Node branch="out" dot="paper">
        <Name>sandbox</Name> <Tag>GitHub, {GITHUB_TOKEN_HOURS} hours</Tag>
      </Node>
      <Node branch="out" dot="red" cut>
        <Name>golden</Name> <Tag tone="is-no">no keys, ever</Tag> <Tag>a token found stops its snapshot</Tag>
      </Node>
    </Figure>
  );
}
