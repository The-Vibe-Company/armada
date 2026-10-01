import Link from "next/link";
import { CopyCommand } from "./Copy";
import { INSTALL, RELEASE, REPOSITORY, VERSION } from "./content";
import { Mark } from "./Mark";
import { Sky } from "./Sky";

const WORDS = ["Run", "a", "fleet", "of", "coding", "agents."];

export function Nav() {
  return (
    <header className="lp-nav">
      <nav className="lp-nav-bar" aria-label="Armada">
        <Link href="/" className="lp-brand">
          <Mark size={20} />
          Armada
        </Link>
        <span className="lp-nav-links">
          <a href="#method">Method</a>
          <a href="#fleet">Fleet</a>
          <a href="#cli">CLI</a>
          <a href="#keys">Keys</a>
        </span>
        <span className="lp-grow" />
        <a href={REPOSITORY} className="lp-nav-quiet" aria-label="Armada on GitHub">
          <GitHubIcon />
          <span className="lp-hide-sm">GitHub</span>
        </a>
        <Link href="/login" className="lp-nav-quiet">
          Sign in
        </Link>
        <a href="#install" className="lp-button is-light is-sm">
          Install
        </a>
      </nav>
    </header>
  );
}

export function Hero() {
  return (
    <section className="lp-hero" id="top" aria-labelledby="lp-title">
      <Sky />
      <div className="lp-hero-scrim" aria-hidden />
      <div className="lp-hero-inner">
        <div className="lp-hero-copy" data-quiet>
          <a href={RELEASE} className="lp-pill lp-enter" style={{ ["--i" as string]: 0 }}>
            <span className="lp-pill-tag">v{VERSION}</span>
            Open source, MIT. See what shipped
            <span aria-hidden className="lp-arrow">
              →
            </span>
          </a>
          <h1 id="lp-title" className="lp-hero-title">
            <span className="lp-line">
              {WORDS.map((w, k) => (
                <span key={w} className="lp-word" style={{ ["--i" as string]: k }}>
                  {w}
                </span>
              ))}
            </span>{" "}
            <span className="lp-line lp-word lp-shine" style={{ ["--i" as string]: WORDS.length + 1 }}>
              See every move.
            </span>
          </h1>
          <p className="lp-lead" style={{ ["--i" as string]: 7 }}>
            Armada gives each ticket to one agent, puts a coordinator in charge of every project, and shows the whole
            fleet live, from the first question to the green merge.
          </p>
          <div className="lp-hero-actions lp-enter" style={{ ["--i" as string]: 4 }}>
            <CopyCommand command={INSTALL} size="lg" />
            <a href={REPOSITORY} className="lp-button is-ghost is-lg">
              <GitHubIcon />
              GitHub
            </a>
          </div>
          <p className="lp-hint lp-enter" style={{ ["--i" as string]: 5 }}>
            Node 22 or later. Workers run on Conductor Cloud or in Claude Code; the tracker is Linear, the code GitHub.
            <span className="lp-hint-sky"> Click the sky to launch a squadron.</span>
          </p>
        </div>
        <div className="lp-hero-mark" data-mark aria-hidden />
      </div>
      <a href="#method" className="lp-scroll" aria-label="Scroll to the method">
        <span />
      </a>
    </section>
  );
}

export function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="lp-icon">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}
