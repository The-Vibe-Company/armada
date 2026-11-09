import Link from "next/link";
import type { ReactNode } from "react";
import { CopyCommand } from "./Copy";
import { CIPHER, GITHUB_TOKEN_HOURS, SETUP, SETUP_GUIDE, STORY } from "./content";
import { ControlFigure, FleetFigure, GoldenFigure, KeysFigure, ResumeFigure, ToolsFigure } from "./Figures";
import { Terminal } from "./Terminal";
import { TRANSCRIPT } from "./transcript";

// The story below the hero (#587): what a developer does with Armada, one
// action per chapter, each beside the diagram of it and the command that does
// it. The anchors are the nav's and the README's (#method, #fleet, #cli,
// #keys, #install): they move with their chapter, never away.

function Chapter({
  id,
  flip = false,
  wide = false,
  title,
  command,
  figure,
  children,
}: {
  id: string;
  flip?: boolean;
  /** The title across the whole chapter, a poster that breaks the rhythm of the two columns. */
  wide?: boolean;
  title: string;
  command: string;
  figure: ReactNode;
  children: ReactNode;
}) {
  const heading = (
    <h2 id={`${id}-title`} className="lp-ch-title">
      {title}
    </h2>
  );
  return (
    <section
      id={id}
      className={`lp-ch${flip ? " is-flip" : ""}${wide ? " is-wide" : ""}`}
      aria-labelledby={`${id}-title`}
    >
      <div className="lp-ch-inner">
        {wide && heading}
        <div className="lp-ch-words">
          {!wide && heading}
          <div className="lp-ch-body">{children}</div>
          <CopyCommand command={command} words />
        </div>
        <div className="lp-ch-figure">{figure}</div>
      </div>
    </section>
  );
}

/**
 * The story's index, under the hero: each chapter, and the way in. It is the key journeys' way through the page
 * (.aeom/journeys), and on a phone, where the top navigation keeps only Sign in and Install, the only one.
 */
const INDEX = [
  ["method", "Method"],
  ["fleet", "Fleet"],
  ["cli", "CLI"],
  ["keys", "Keys"],
  ["install", "Install"],
] as const;

export function Story() {
  return (
    <>
      <nav className="lp-index" aria-label="The story">
        <div className="lp-index-inner">
          <div className="lp-index-links">
            {INDEX.map(([id, label]) => (
              <a key={id} href={`#${id}`}>
                {label}
              </a>
            ))}
          </div>
          <Link href="/login" className="lp-button is-lime is-sm">
            Sign in to try Armada
          </Link>
        </div>
      </nav>
      <Chapter id="method" title="Set up your repos once." command={STORY.golden} figure={<GoldenFigure />}>
        <p>
          A golden is your repositories, cloned over your own GitHub connection, set up by your script and saved as a
          snapshot on the provider you build it for, Boat or Modal. Every agent starts there, already set up, instead of
          from a cold clone.
        </p>
        <p>
          Armada scans the working tree and the Git history for GitHub tokens before it saves a snapshot. Share a golden
          with your org or keep it private.
        </p>
      </Chapter>

      <Chapter id="fleet" flip title="Launch one agent, or ten." command={STORY.launch} figure={<FleetFigure />}>
        <p>
          Each launch forks the golden into a sandbox of its own: its own machine, its own files, and of your stored
          keys only its agent's. Run four fixes at once and none of them touches another's checkout.
        </p>
        <p>
          Choose Claude Code or Codex, the model and the reasoning effort for each launch. Every later turn keeps them.
        </p>
      </Chapter>

      <Chapter id="tools" title="Hand them your tools." command={STORY.tools} figure={<ToolsFigure />}>
        <p>
          Register an MCP server once, for yourself or for your org: over HTTP, SSE or stdio, with OAuth, a bearer token
          or headers. Pick which connections a launch gets, from the dashboard or with <code>--connections</code>.
        </p>
        <p>Armada prepares them before every turn. Their secrets are stored encrypted and never shown again.</p>
      </Chapter>

      <Chapter
        id="resume"
        flip
        title="Stop the machine. Keep the thread."
        command={STORY.resume}
        figure={<ResumeFigure />}
      >
        <p>
          Stopping a sandbox removes its machine and keeps its disk and the agent's conversation, so idle work stops
          costing. Send the next prompt and it resumes where it left off, connections prepared again.
        </p>
        <p>A sandbox also stops on its own when its time runs out: four hours unless you set another.</p>
      </Chapter>

      <Chapter
        id="cli"
        wide
        title="Drive it from the browser, the terminal or your agent."
        command={STORY.watch}
        figure={<ControlFigure />}
      >
        <p>
          The dashboard, the <code>armada</code> CLI and the remote MCP server go through the same API under the same
          rules: who sees a golden, who may launch, which keys a sandbox gets.
        </p>
        <p>
          Launch from the web, follow the logs in your terminal, and let the agent that plans your work send, steer,
          wait and stop through MCP tools. Armada launches; your agent decides what to launch.
        </p>
      </Chapter>

      <Chapter id="keys" flip title="Your keys stay in Armada." command={STORY.keys} figure={<KeysFigure />}>
        <p>
          Store each agent's key once, for you or your org, sealed with {CIPHER}. It goes in through stdin or a file,
          never an argument, and no page or command shows it again. Terminals hold only their Armada session.
        </p>
        <p>
          Of your stored keys, a sandbox gets only its agent's. Git and gh act as you through the GitHub App, with a
          token that lasts {GITHUB_TOKEN_HOURS} hours. A golden gets no key: a GitHub token found in one stops its
          snapshot.
        </p>
      </Chapter>

      <Install />
    </>
  );
}

function Install() {
  return (
    <section id="install" className="lp-ch lp-try" aria-labelledby="install-title">
      <div className="lp-ch-inner">
        <div className="lp-ch-words">
          <h2 id="install-title" className="lp-ch-title">
            Launch your first agent.
          </h2>
          <div className="lp-ch-body">
            <p>
              Sign in, connect Boat or Modal to your org, store your agent's key and connect GitHub. Then build a golden
              and launch.
            </p>
          </div>
          <div className="lp-try-actions">
            <Link href="/login" className="lp-try-primary">
              Sign in to try Armada
            </Link>
            <a href={SETUP_GUIDE} className="lp-try-link">
              Read the setup guide
            </a>
          </div>
          <h3 className="lp-try-sub">Or from your terminal</h3>
          <ol className="lp-try-steps">
            {SETUP.map((s) => (
              <li key={s.command}>
                <CopyCommand command={s.command} note={s.note} words />
              </li>
            ))}
          </ol>
        </div>
        <div className="lp-ch-figure lp-try-terminal">
          <Terminal commands={TRANSCRIPT} title="armada · widgets" />
        </div>
      </div>
    </section>
  );
}
